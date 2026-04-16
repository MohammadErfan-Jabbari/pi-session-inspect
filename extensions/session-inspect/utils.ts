import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	buildSessionContext,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	migrateSessionEntries,
	parseSessionEntries,
	truncateHead,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";

export const ACTION_VALUES = ["current", "list", "search", "read"] as const;
export const SCOPE_VALUES = ["cwd", "repo", "all"] as const;
export const KIND_VALUES = ["top-level", "nested", "all"] as const;
export const VIEW_VALUES = ["summary", "turns", "entries", "context"] as const;

export type InspectAction = (typeof ACTION_VALUES)[number];
export type InspectScope = (typeof SCOPE_VALUES)[number];
export type InspectKind = (typeof KIND_VALUES)[number];
export type InspectView = (typeof VIEW_VALUES)[number];
export type SessionKind = Exclude<InspectKind, "all">;

export interface SessionInspectParams {
	action: InspectAction;
	scope?: InspectScope;
	kind?: InspectKind;
	session?: string;
	query?: string;
	view?: InspectView;
	offset?: number;
	limit?: number;
}

export interface SessionContextInfo {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	persisted: boolean;
	repoRoot?: string;
	suggestedTmpDir?: string;
	sessionsRoot: string;
}

export interface DiscoveredSession {
	path: string;
	sessionId: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	kind: SessionKind;
	relativePath: string;
	nestingDepth: number;
	topLevelSessionPath?: string;
	topLevelSessionId?: string;
	nestedSessionCount: number;
}

export interface ScopeResolution {
	requestedScope: InspectScope;
	effectiveScope: "cwd" | "repo" | "all";
	repoRoot?: string;
	note?: string;
}

export interface SearchResult extends DiscoveredSession {
	score: number;
	snippet: string;
}

interface ParsedTurn {
	turnNumber: number;
	startTimestamp?: string;
	endTimestamp?: string;
	startEntryId: string;
	endEntryId: string;
	userText: string;
	assistantExcerpt: string;
	assistantMessageCount: number;
	toolCalls: string[];
	toolResults: string[];
	toolErrorCount: number;
	structuralEvents: string[];
}

interface PaginatedResult<T> {
	items: T[];
	offset: number;
	limit: number;
	total: number;
	hasMore: boolean;
}

interface LoadedSessionData {
	header: any;
	entries: any[];
	byId: Map<string, any>;
	leafId: string | null;
	sessionName?: string;
}

const SESSION_BUCKET_PATTERN = /^--.*--$/;
const DEFAULT_LIST_LIMIT = 10;
const DEFAULT_DETAIL_LIMIT = 20;
const MAX_LIMIT = 100;
const EXCERPT_CHARS = 220;
const SEARCH_SNIPPET_CHARS = 180;

const sessionInfoCache = new Map<string, { mtimeMs: number; size: number; info: DiscoveredSession | null }>();

export async function getCurrentSessionInfo(cwd: string, sessionManager: {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getSessionName(): string | undefined;
	getSessionDir(): string;
	getCwd(): string;
}): Promise<SessionContextInfo> {
	const sessionId = sessionManager.getSessionId();
	const sessionFile = sessionManager.getSessionFile();
	const repoRoot = findGitRoot(cwd);
	const sessionsRoot = await resolveSessionsRoot(sessionFile, sessionManager.getSessionDir());
	return {
		sessionId,
		sessionFile,
		sessionName: sessionManager.getSessionName(),
		cwd: sessionManager.getCwd(),
		persisted: Boolean(sessionFile),
		repoRoot,
		suggestedTmpDir: repoRoot ? join(repoRoot, "tmp", "sessions", sessionId) : undefined,
		sessionsRoot,
	};
}

export async function discoverSessions(sessionsRoot: string): Promise<DiscoveredSession[]> {
	if (!existsSync(sessionsRoot)) return [];

	const files = await collectJsonlFiles(sessionsRoot);
	const sessions: DiscoveredSession[] = [];

	for (const filePath of files) {
		const fileStat = await stat(filePath);
		const cached = sessionInfoCache.get(filePath);
		if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
			if (cached.info) sessions.push({ ...cached.info });
			continue;
		}

		const info = await summarizeSessionFile(filePath, sessionsRoot, fileStat.mtimeMs, fileStat.size);
		sessionInfoCache.set(filePath, {
			mtimeMs: fileStat.mtimeMs,
			size: fileStat.size,
			info,
		});
		if (info) sessions.push(info);
	}

	const byPath = new Map(sessions.map((session) => [session.path, session]));
	const nestedCounts = new Map<string, number>();

	for (const session of sessions) {
		if (!session.topLevelSessionPath) continue;
		nestedCounts.set(session.topLevelSessionPath, (nestedCounts.get(session.topLevelSessionPath) ?? 0) + 1);
		const topLevel = byPath.get(session.topLevelSessionPath);
		if (topLevel) session.topLevelSessionId = topLevel.sessionId;
	}

	for (const session of sessions) {
		session.nestedSessionCount = nestedCounts.get(session.path) ?? 0;
	}

	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

export function resolveScope(cwd: string, requestedScope: InspectScope | undefined): ScopeResolution {
	const scope = requestedScope ?? "repo";
	if (scope === "all") return { requestedScope: scope, effectiveScope: "all" };
	if (scope === "cwd") return { requestedScope: scope, effectiveScope: "cwd" };

	const repoRoot = findGitRoot(cwd);
	if (repoRoot) {
		return { requestedScope: scope, effectiveScope: "repo", repoRoot };
	}

	return {
		requestedScope: scope,
		effectiveScope: "cwd",
		note: "Requested repo scope, but the current cwd is not inside a git repo. Falling back to exact cwd scope.",
	};
}

export function filterSessions(sessions: DiscoveredSession[], cwd: string, scope: ScopeResolution, kind: InspectKind | undefined): DiscoveredSession[] {
	const requestedKind = kind ?? "top-level";
	return sessions.filter((session) => {
		if (requestedKind !== "all" && session.kind !== requestedKind) return false;

		switch (scope.effectiveScope) {
			case "all":
				return true;
			case "cwd":
				return session.cwd === cwd;
			case "repo":
				return Boolean(scope.repoRoot && session.cwd && isWithin(scope.repoRoot, session.cwd));
		}
	});
}

export function searchSessions(sessions: DiscoveredSession[], rawQuery: string): SearchResult[] {
	const query = rawQuery.trim().toLowerCase();
	if (!query) throw new Error("search requires a non-empty query");
	const terms = query.split(/\s+/).filter(Boolean);

	const results: SearchResult[] = [];
	for (const session of sessions) {
		const fields = {
			id: session.sessionId.toLowerCase(),
			path: session.path.toLowerCase(),
			name: (session.name ?? "").toLowerCase(),
			firstMessage: session.firstMessage.toLowerCase(),
			messages: session.allMessagesText.toLowerCase(),
		};

		let score = 0;
		if (fields.id === query) score += 300;
		if (fields.id.startsWith(query)) score += 250;
		if (fields.path.includes(query)) score += 150;
		if (fields.name.includes(query)) score += 140;
		if (fields.firstMessage.includes(query)) score += 120;
		if (fields.messages.includes(query)) score += 60;

		for (const term of terms) {
			if (fields.name.includes(term)) score += 30;
			if (fields.firstMessage.includes(term)) score += 20;
			if (fields.path.includes(term)) score += 15;
			if (fields.messages.includes(term)) score += 5;
		}

		if (score <= 0) continue;
		results.push({
			...session,
			score,
			snippet: buildSearchSnippet(session, query, terms),
		});
	}

	results.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.modified.getTime() - a.modified.getTime();
	});
	return results;
}

export function resolveSessionSpecifier(specifier: string | undefined, currentSessionFile: string | undefined, sessions: DiscoveredSession[], cwd: string): string {
	if (!specifier || specifier === "current") {
		if (!currentSessionFile) {
			throw new Error("The current session is not persisted. Use an explicit discovered session id or path.");
		}
		return currentSessionFile;
	}

	const normalizedSpecifier = isAbsolute(specifier) ? specifier : resolve(cwd, specifier);
	if (currentSessionFile && normalizedSpecifier === currentSessionFile) {
		return currentSessionFile;
	}

	const exactPath = sessions.find((session) => session.path === specifier || session.path === normalizedSpecifier);
	if (exactPath) return exactPath.path;

	const exactId = sessions.find((session) => session.sessionId === specifier);
	if (exactId) return exactId.path;

	const prefixMatches = sessions.filter((session) => session.sessionId.startsWith(specifier));
	if (prefixMatches.length === 1) return prefixMatches[0].path;
	if (prefixMatches.length > 1) {
		const candidates = prefixMatches
			.slice(0, 5)
			.map((session) => `${session.sessionId} (${session.path})`)
			.join("\n");
		throw new Error(`Session id prefix is ambiguous. Matches:\n${candidates}`);
	}

	throw new Error(`Could not resolve session: ${specifier}`);
}

export function paginate<T>(items: T[], offset: number | undefined, limit: number | undefined, fallbackLimit: number): PaginatedResult<T> {
	const safeOffset = Math.max(0, Math.floor(offset ?? 0));
	const safeLimit = clampLimit(limit ?? fallbackLimit);
	const paged = items.slice(safeOffset, safeOffset + safeLimit);
	return {
		items: paged,
		offset: safeOffset,
		limit: safeLimit,
		total: items.length,
		hasMore: safeOffset + safeLimit < items.length,
	};
}

export function readSessionView(sessionPath: string, view: InspectView | undefined, offset: number | undefined, limit: number | undefined, discoveredSessions: DiscoveredSession[]) {
	const resolvedView = view ?? "summary";
	const loaded = loadSessionForInspection(sessionPath);
	const session = discoveredSessions.find((candidate) => candidate.path === sessionPath);

	if (resolvedView === "summary") {
		const summary = buildSummaryView(loaded, sessionPath, session, discoveredSessions);
		return finalizeOutput(summary.text, { view: resolvedView, summary: summary.details });
	}

	if (resolvedView === "turns") {
		const turns = buildTurnsView(loaded, offset, limit);
		return finalizeOutput(turns.text, { view: resolvedView, turns: turns.details });
	}

	if (resolvedView === "entries") {
		const entries = buildEntriesView(loaded, offset, limit);
		return finalizeOutput(entries.text, { view: resolvedView, entries: entries.details });
	}

	const context = buildContextView(loaded, offset, limit);
	return finalizeOutput(context.text, { view: resolvedView, context: context.details });
}

function loadSessionForInspection(sessionPath: string): LoadedSessionData {
	if (!existsSync(sessionPath)) {
		throw new Error(`Session file does not exist: ${sessionPath}`);
	}
	const raw = readFileSync(sessionPath, "utf8");
	const fileEntries = parseSessionEntries(raw) as any[];
	if (fileEntries.length === 0) {
		throw new Error(`Not a readable Pi session file: ${sessionPath}`);
	}
	if (fileEntries[0]?.type !== "session" || typeof fileEntries[0]?.id !== "string") {
		throw new Error(`Not a valid Pi session header: ${sessionPath}`);
	}

	const cloned = fileEntries.map((entry) => JSON.parse(JSON.stringify(entry)));
	migrateSessionEntries(cloned);
	const [header, ...entries] = cloned as any[];
	if (!header || header.type !== "session") {
		throw new Error(`Not a valid Pi session header: ${sessionPath}`);
	}

	const byId = new Map<string, any>();
	let sessionName: string | undefined;
	for (const entry of entries) {
		if (entry && typeof entry.id === "string") {
			byId.set(entry.id, entry);
		}
		if (entry?.type === "session_info") {
			sessionName = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
		}
	}

	const leafId = entries.length > 0 && typeof entries[entries.length - 1]?.id === "string"
		? entries[entries.length - 1].id
		: null;

	return { header, entries, byId, leafId, sessionName };
}

function getBranchEntries(loaded: LoadedSessionData): any[] {
	const branch: any[] = [];
	let current = loaded.leafId ? loaded.byId.get(loaded.leafId) : undefined;
	while (current) {
		branch.unshift(current);
		current = current.parentId ? loaded.byId.get(current.parentId) : undefined;
	}
	return branch;
}

export function formatCurrentSession(current: SessionContextInfo) {
	const lines = [
		"Current Pi session",
		`- sessionId: ${current.sessionId}`,
		`- sessionFile: ${current.sessionFile ?? "(ephemeral)"}`,
		`- sessionName: ${current.sessionName ?? "(unnamed)"}`,
		`- cwd: ${current.cwd}`,
		`- persisted: ${current.persisted ? "yes" : "no"}`,
		`- repoRoot: ${current.repoRoot ?? "(none)"}`,
		`- suggestedTmpDir: ${current.suggestedTmpDir ?? "(none)"}`,
		`- sessionsRoot: ${current.sessionsRoot}`,
	];
	return finalizeOutput(lines.join("\n"), { current });
}

export function formatListResult(sessions: DiscoveredSession[], pagination: PaginatedResult<DiscoveredSession>, scope: ScopeResolution, kind: InspectKind | undefined) {
	const lines = [
		`Session list (scope: ${scope.effectiveScope}${scope.requestedScope !== scope.effectiveScope ? `; requested ${scope.requestedScope}` : ""}, kind: ${kind ?? "top-level"}, total: ${pagination.total}, showing: ${pagination.items.length})`,
	];
	if (scope.note) lines.push(`Note: ${scope.note}`);
	if (pagination.items.length === 0) {
		lines.push("No sessions matched.");
		return finalizeOutput(lines.join("\n"), {
			scope,
			kind: kind ?? "top-level",
			pagination,
			sessions: [],
		});
	}

	for (const [index, session] of pagination.items.entries()) {
		const number = pagination.offset + index + 1;
		lines.push("");
		lines.push(`${number}. ${session.sessionId} [${session.kind}]`);
		lines.push(`   path: ${session.path}`);
		lines.push(`   cwd: ${session.cwd || "(unknown)"}`);
		lines.push(`   name: ${session.name ?? "(unnamed)"}`);
		lines.push(`   created: ${session.created.toISOString()}`);
		lines.push(`   modified: ${session.modified.toISOString()}`);
		lines.push(`   messageCount: ${session.messageCount}`);
		lines.push(`   first: ${excerptText(session.firstMessage, EXCERPT_CHARS)}`);
		if (session.kind === "top-level") {
			lines.push(`   nestedSessionCount: ${session.nestedSessionCount}`);
		} else {
			lines.push(`   relativePath: ${session.relativePath}`);
			if (session.topLevelSessionId) {
				lines.push(`   topLevelSessionId: ${session.topLevelSessionId}`);
			}
		}
	}

	return finalizeOutput(lines.join("\n"), {
		scope,
		kind: kind ?? "top-level",
		pagination,
		sessions: pagination.items.map((session) => serializeSession(session)),
	});
}

export function formatSearchResult(results: SearchResult[], pagination: PaginatedResult<SearchResult>, scope: ScopeResolution, kind: InspectKind | undefined, query: string) {
	const lines = [
		`Session search for ${JSON.stringify(query)} (scope: ${scope.effectiveScope}${scope.requestedScope !== scope.effectiveScope ? `; requested ${scope.requestedScope}` : ""}, kind: ${kind ?? "top-level"}, total: ${pagination.total}, showing: ${pagination.items.length})`,
	];
	if (scope.note) lines.push(`Note: ${scope.note}`);
	if (pagination.items.length === 0) {
		lines.push("No sessions matched.");
		return finalizeOutput(lines.join("\n"), {
			query,
			scope,
			kind: kind ?? "top-level",
			pagination,
			results: [],
		});
	}

	for (const [index, result] of pagination.items.entries()) {
		const number = pagination.offset + index + 1;
		lines.push("");
		lines.push(`${number}. ${result.sessionId} [${result.kind}] score=${result.score}`);
		lines.push(`   path: ${result.path}`);
		lines.push(`   cwd: ${result.cwd || "(unknown)"}`);
		lines.push(`   name: ${result.name ?? "(unnamed)"}`);
		lines.push(`   created: ${result.created.toISOString()}`);
		lines.push(`   modified: ${result.modified.toISOString()}`);
		lines.push(`   messageCount: ${result.messageCount}`);
		lines.push(`   snippet: ${result.snippet}`);
	}

	return finalizeOutput(lines.join("\n"), {
		query,
		scope,
		kind: kind ?? "top-level",
		pagination,
		results: pagination.items.map((result) => ({
			...serializeSession(result),
			score: result.score,
			snippet: result.snippet,
		})),
	});
}

function clampLimit(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function findGitRoot(startPath: string): string | undefined {
	let current = resolve(startPath);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function resolveSessionsRoot(currentSessionFile: string | undefined, currentSessionDir?: string): Promise<string> {
	const fromCurrent = currentSessionFile ? await deriveSessionsRootFromCurrentFile(currentSessionFile) : undefined;
	if (fromCurrent) return fromCurrent;
	const fromSessionDir = currentSessionDir ? await deriveSessionsRootFromCurrentDir(currentSessionDir) : undefined;
	if (fromSessionDir) return fromSessionDir;
	return join(getAgentDir(), "sessions");
}

async function deriveSessionsRootFromCurrentDir(currentSessionDir: string): Promise<string | undefined> {
	const resolved = resolve(currentSessionDir);
	if (SESSION_BUCKET_PATTERN.test(basename(resolved))) {
		return dirname(resolved);
	}
	try {
		const entries = await readdir(resolved, { withFileTypes: true });
		if (entries.some((entry) => entry.isDirectory() && SESSION_BUCKET_PATTERN.test(entry.name))) {
			return resolved;
		}
		if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))) {
			return resolved;
		}
	} catch {
		// ignore
	}
	return undefined;
}

async function deriveSessionsRootFromCurrentFile(currentSessionFile: string): Promise<string | undefined> {
	const resolvedFile = resolve(currentSessionFile);
	const matches: string[] = [];
	let current = dirname(resolvedFile);
	while (true) {
		const candidate = candidateSessionsRootForFile(current, resolvedFile);
		if (candidate) matches.push(candidate);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return matches.length ? matches[matches.length - 1] : undefined;
}

function candidateSessionsRootForFile(candidateRoot: string, sessionFile: string): string | undefined {
	const rel = normalizeRel(relative(candidateRoot, sessionFile));
	if (!rel || rel.startsWith("..")) return undefined;
	const parts = rel.split("/").filter(Boolean);
	if (parts.length === 0) return undefined;
	const bucketedLayout = SESSION_BUCKET_PATTERN.test(parts[0]);

	if (bucketedLayout) {
		if (parts.length === 2 && parts[1].endsWith(".jsonl")) return candidateRoot;
		if (parts.length > 2) {
			const topLevelCandidate = join(candidateRoot, parts[0], `${parts[1]}.jsonl`);
			if (existsSync(topLevelCandidate)) return candidateRoot;
		}
		return undefined;
	}

	if (parts.length === 1 && parts[0].endsWith(".jsonl")) return candidateRoot;
	if (parts.length > 1) {
		const topLevelCandidate = join(candidateRoot, `${parts[0]}.jsonl`);
		if (existsSync(topLevelCandidate)) return candidateRoot;
	}
	return undefined;
}

async function collectJsonlFiles(root: string): Promise<string[]> {
	const files: string[] = [];

	async function walk(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(fullPath);
			}
		}
	}

	await walk(root);
	files.sort();
	return files;
}

async function summarizeSessionFile(filePath: string, sessionsRoot: string, fallbackModifiedMs: number, size: number): Promise<DiscoveredSession | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const lines = content.trim().split("\n");
		if (lines.length === 0) return null;

		const entries: any[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// skip malformed lines
			}
		}

		if (entries.length === 0) return null;
		const header = entries[0];
		if (header?.type !== "session") return null;

		const relativePath = normalizeRel(relative(sessionsRoot, filePath));
		const parts = relativePath.split("/").filter(Boolean);
		if (parts.length < 1) return null;

		const bucketedLayout = SESSION_BUCKET_PATTERN.test(parts[0]);
		const kind: SessionKind = bucketedLayout
			? parts.length === 2 ? "top-level" : "nested"
			: parts.length === 1 ? "top-level" : "nested";
		const topLevelSessionPath = kind === "nested"
			? resolveTopLevelSessionPath(sessionsRoot, parts)
			: undefined;

		let messageCount = 0;
		let name: string | undefined;
		let firstMessage = "";
		const allMessages: string[] = [];
		let modifiedMs = parseTimestamp(header.timestamp) ?? fallbackModifiedMs;

		for (const entry of entries) {
			modifiedMs = Math.max(modifiedMs, parseTimestamp(entry?.timestamp) ?? modifiedMs);
			if (entry?.type === "session_info") {
				name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
			}
			if (entry?.type !== "message") continue;

			messageCount += 1;
			const message = entry.message;
			if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
			const text = extractTextForSearch(message);
			if (!text) continue;
			allMessages.push(text);
			if (!firstMessage && message.role === "user") {
				firstMessage = text;
			}
		}

		const created = new Date(parseTimestamp(header.timestamp) ?? fallbackModifiedMs);
		return {
			path: filePath,
			sessionId: typeof header.id === "string" ? header.id : basename(filePath, ".jsonl"),
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			name,
			parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
			created,
			modified: new Date(modifiedMs),
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" ").trim(),
			kind,
			relativePath,
			nestingDepth: bucketedLayout ? Math.max(0, parts.length - 2) : Math.max(0, parts.length - 1),
			topLevelSessionPath,
			nestedSessionCount: 0,
		};
	} catch {
		return null;
	}
}

function resolveTopLevelSessionPath(sessionsRoot: string, parts: string[]): string | undefined {
	if (parts.length < 2) return undefined;
	const bucketedLayout = SESSION_BUCKET_PATTERN.test(parts[0]);
	const candidate = bucketedLayout
		? parts.length < 3 ? undefined : join(sessionsRoot, parts[0], `${parts[1]}.jsonl`)
		: join(sessionsRoot, `${parts[0]}.jsonl`);
	return candidate && existsSync(candidate) ? candidate : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function extractTextForSearch(message: any): string {
	const summary = summarizeMessageContent(message?.content, {
		includeToolCallNames: false,
		includeThinking: false,
		imagePlaceholder: true,
	});
	return summary.text || summary.placeholder || "";
}

function summarizeMessageContent(content: unknown, options?: {
	includeToolCallNames?: boolean;
	includeThinking?: boolean;
	imagePlaceholder?: boolean;
}) {
	const settings = {
		includeToolCallNames: options?.includeToolCallNames ?? false,
		includeThinking: options?.includeThinking ?? false,
		imagePlaceholder: options?.imagePlaceholder ?? false,
	};

	if (typeof content === "string") {
		return { text: sanitizeOpaqueText(content.trim()), toolCalls: [] as string[], imageCount: 0, thinkingCount: 0, placeholder: "" };
	}
	if (!Array.isArray(content)) {
		return { text: "", toolCalls: [] as string[], imageCount: 0, thinkingCount: 0, placeholder: "" };
	}

	const textParts: string[] = [];
	const toolCalls: string[] = [];
	let imageCount = 0;
	let thinkingCount = 0;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		switch ((block as any).type) {
			case "text": {
				const text = typeof (block as any).text === "string" ? sanitizeOpaqueText((block as any).text.trim()) : "";
				if (text) textParts.push(text);
				break;
			}
			case "image": {
				imageCount += 1;
				break;
			}
			case "toolCall": {
				if (settings.includeToolCallNames && typeof (block as any).name === "string") {
					toolCalls.push((block as any).name);
				}
				break;
			}
			case "thinking": {
				thinkingCount += 1;
				if (settings.includeThinking && typeof (block as any).thinking === "string") {
					const thinking = sanitizeOpaqueText((block as any).thinking.trim());
					if (thinking) textParts.push(thinking);
				}
				break;
			}
		}
	}

	let placeholder = "";
	if (!textParts.length && settings.imagePlaceholder && imageCount > 0) {
		placeholder = imageCount === 1 ? "[1 image omitted]" : `[${imageCount} images omitted]`;
	}

	return {
		text: textParts.join(" ").trim(),
		toolCalls,
		imageCount,
		thinkingCount,
		placeholder,
	};
}

function buildSearchSnippet(session: DiscoveredSession, query: string, terms: string[]): string {
	const candidates = [
		session.name,
		session.firstMessage,
		session.allMessagesText,
		session.path,
	].filter(Boolean) as string[];

	for (const candidate of candidates) {
		const snippet = excerptAroundMatch(candidate, [query, ...terms], SEARCH_SNIPPET_CHARS);
		if (snippet) return snippet;
	}

	return excerptText(session.firstMessage || session.path, SEARCH_SNIPPET_CHARS);
}

function excerptAroundMatch(text: string, terms: string[], maxChars: number): string | undefined {
	const lower = text.toLowerCase();
	const found = terms
		.filter(Boolean)
		.map((term) => ({ term, index: lower.indexOf(term) }))
		.filter((entry) => entry.index >= 0)
		.sort((a, b) => a.index - b.index)[0];
	if (!found) return undefined;

	const start = Math.max(0, found.index - Math.floor(maxChars / 3));
	const end = Math.min(text.length, start + maxChars);
	let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
	if (start > 0) snippet = `…${snippet}`;
	if (end < text.length) snippet = `${snippet}…`;
	return snippet;
}

function buildSummaryView(loaded: LoadedSessionData, sessionPath: string, session: DiscoveredSession | undefined, discoveredSessions: DiscoveredSession[]) {
	const header = loaded.header;
	const entries = loaded.entries;
	const entryTypeCounts = new Map<string, number>();
	const roleCounts = new Map<string, number>();
	let firstUserMessage = "";
	let lastUserMessage = "";
	let labelCount = 0;
	let compactionCount = 0;
	let customCount = 0;
	const childCounts = new Map<string, number>();

	for (const entry of entries) {
		entryTypeCounts.set(entry.type, (entryTypeCounts.get(entry.type) ?? 0) + 1);
		if (entry.parentId) {
			childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
		}
		if (entry.type === "label") labelCount += 1;
		if (entry.type === "compaction") compactionCount += 1;
		if (entry.type === "custom" || entry.type === "custom_message") customCount += 1;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message.role !== "string") continue;
		roleCounts.set(message.role, (roleCounts.get(message.role) ?? 0) + 1);
		if (message.role !== "user") continue;
		const text = extractTextForSearch(message);
		if (!text) continue;
		if (!firstUserMessage) firstUserMessage = text;
		lastUserMessage = text;
	}

	const branchPoints = Array.from(childCounts.values()).filter((count) => count > 1).length;
	const allNestedChildren = discoveredSessions.filter((candidate) => candidate.topLevelSessionPath === sessionPath);
	const nestedChildren = allNestedChildren.slice(0, 10).map((candidate) => ({
		sessionId: candidate.sessionId,
		path: candidate.path,
		modified: candidate.modified.toISOString(),
		name: candidate.name,
	}));

	const details = {
		sessionId: header?.id,
		path: sessionPath,
		kind: session?.kind ?? inferKindFromPath(sessionPath),
		cwd: header?.cwd ?? session?.cwd,
		name: session?.name ?? loaded.sessionName,
		created: header?.timestamp,
		modified: session?.modified.toISOString(),
		parentSessionPath: header?.parentSession,
		leafEntryId: loaded.leafId,
		entryCount: entries.length,
		entryTypeCounts: Object.fromEntries(entryTypeCounts),
		messageRoleCounts: Object.fromEntries(roleCounts),
		branchPoints,
		firstUserMessage: firstUserMessage || "(none)",
		lastUserMessage: lastUserMessage || "(none)",
		labelCount,
		compactionCount,
		customCount,
		nestedChildSessionCount: allNestedChildren.length,
		nestedChildren,
		topLevelSessionPath: session?.topLevelSessionPath,
		topLevelSessionId: session?.topLevelSessionId,
	};

	const lines = [
		"Session summary",
		`- sessionId: ${details.sessionId}`,
		`- path: ${details.path}`,
		`- kind: ${details.kind}`,
		`- cwd: ${details.cwd ?? "(unknown)"}`,
		`- name: ${details.name ?? "(unnamed)"}`,
		`- created: ${details.created ?? "(unknown)"}`,
		`- modified: ${details.modified ?? "(unknown)"}`,
		`- parentSessionPath: ${details.parentSessionPath ?? "(none)"}`,
		`- topLevelSessionPath: ${details.topLevelSessionPath ?? "(none)"}`,
		`- leafEntryId: ${details.leafEntryId ?? "(none)"}`,
		`- entryCount: ${details.entryCount}`,
		`- branchPoints: ${details.branchPoints}`,
		`- firstUserMessage: ${excerptText(details.firstUserMessage, EXCERPT_CHARS)}`,
		`- lastUserMessage: ${excerptText(details.lastUserMessage, EXCERPT_CHARS)}`,
		`- entryTypeCounts: ${formatCountMap(details.entryTypeCounts)}`,
		`- messageRoleCounts: ${formatCountMap(details.messageRoleCounts)}`,
		`- compactionCount: ${details.compactionCount}`,
		`- labelCount: ${details.labelCount}`,
		`- customEntryCount: ${details.customCount}`,
		`- nestedChildSessionCount: ${details.nestedChildSessionCount}`,
	];

	if (nestedChildren.length > 0) {
		lines.push("- nestedChildren:");
		for (const child of nestedChildren) {
			lines.push(`  - ${child.sessionId} ${child.name ? `(${child.name}) ` : ""}${child.path}`);
		}
	}

	return { text: lines.join("\n"), details };
}

function buildTurnsView(loaded: LoadedSessionData, offset: number | undefined, limit: number | undefined) {
	const branchEntries = getBranchEntries(loaded);
	const turns = normalizeTurns(branchEntries);
	const pagination = paginate(turns, offset, limit, DEFAULT_DETAIL_LIMIT);
	const lines = [
		`Turns view (active branch only, total turns: ${pagination.total}, showing: ${pagination.items.length})`,
	];
	if (pagination.total === 0) {
		lines.push("No user-centered turns found on the active branch.");
		return { text: lines.join("\n"), details: { pagination, items: [] } };
	}

	for (const turn of pagination.items) {
		lines.push("");
		lines.push(`Turn ${turn.turnNumber}`);
		lines.push(`- timestamps: ${turn.startTimestamp ?? "?"} -> ${turn.endTimestamp ?? "?"}`);
		lines.push(`- entryIds: ${turn.startEntryId} -> ${turn.endEntryId}`);
		lines.push(`- user: ${excerptText(turn.userText, EXCERPT_CHARS)}`);
		lines.push(`- assistant: ${excerptText(turn.assistantExcerpt || "(no assistant text)", EXCERPT_CHARS)}`);
		lines.push(`- assistantMessages: ${turn.assistantMessageCount}`);
		lines.push(`- toolCalls: ${turn.toolCalls.length ? turn.toolCalls.join(", ") : "(none)"}`);
		lines.push(`- toolResults: ${turn.toolResults.length ? turn.toolResults.join(", ") : "(none)"}`);
		lines.push(`- toolErrorCount: ${turn.toolErrorCount}`);
		if (turn.structuralEvents.length) {
			lines.push(`- structuralEvents: ${turn.structuralEvents.join(", ")}`);
		}
	}

	return {
		text: lines.join("\n"),
		details: {
			pagination,
			items: pagination.items,
		},
	};
}

function buildEntriesView(loaded: LoadedSessionData, offset: number | undefined, limit: number | undefined) {
	const entries = loaded.entries;
	const normalized = entries.map((entry) => normalizeEntry(entry));
	const pagination = paginate(normalized, offset, limit, DEFAULT_DETAIL_LIMIT);
	const lines = [
		`Entries view (whole file in append order, total entries: ${pagination.total}, showing: ${pagination.items.length})`,
	];
	if (pagination.total === 0) {
		lines.push("No entries found.");
		return { text: lines.join("\n"), details: { pagination, items: [] } };
	}

	for (const [index, entry] of pagination.items.entries()) {
		const number = pagination.offset + index + 1;
		lines.push("");
		lines.push(`${number}. [${entry.type}] ${entry.entryId}`);
		lines.push(`   parentId: ${entry.parentId ?? "(root)"}`);
		lines.push(`   timestamp: ${entry.timestamp ?? "(unknown)"}`);
		if (entry.role) lines.push(`   role: ${entry.role}`);
		if (entry.toolName) lines.push(`   toolName: ${entry.toolName}`);
		if (typeof entry.isError === "boolean") lines.push(`   isError: ${entry.isError}`);
		if (entry.summary) lines.push(`   summary: ${excerptText(entry.summary, EXCERPT_CHARS)}`);
		if (entry.extra) lines.push(`   extra: ${entry.extra}`);
		if (entry.text) lines.push(`   text: ${excerptText(entry.text, EXCERPT_CHARS)}`);
	}

	return {
		text: lines.join("\n"),
		details: {
			pagination,
			items: pagination.items,
		},
	};
}

function buildContextView(loaded: LoadedSessionData, offset: number | undefined, limit: number | undefined) {
	const context = buildSessionContext(loaded.entries, loaded.leafId, loaded.byId) as any;
	const messages = Array.isArray(context.messages) ? context.messages.map((message: any, index: number) => normalizeContextMessage(message, index)) : [];
	const pagination = paginate(messages, offset, limit, DEFAULT_DETAIL_LIMIT);
	const lines = [
		`Context view (lossy, active branch only, total messages: ${pagination.total}, showing: ${pagination.items.length})`,
		`- thinkingLevel: ${context.thinkingLevel ?? "(unknown)"}`,
		`- model: ${formatModel(context.model)}`,
	];
	if (pagination.total === 0) {
		lines.push("No context messages found.");
		return { text: lines.join("\n"), details: { ...context, pagination, items: [] } };
	}

	for (const item of pagination.items) {
		lines.push("");
		lines.push(`${item.index + 1}. [${item.role}] ${item.summary}`);
	}

	return {
		text: lines.join("\n"),
		details: {
			thinkingLevel: context.thinkingLevel,
			model: context.model,
			pagination,
			items: pagination.items,
		},
	};
}

function normalizeTurns(branchEntries: any[]): ParsedTurn[] {
	const turns: ParsedTurn[] = [];
	let currentTurn: ParsedTurn | undefined;

	for (const entry of branchEntries) {
		if (entry.type === "message" && entry.message?.role === "user") {
			if (currentTurn) turns.push(currentTurn);
			currentTurn = {
				turnNumber: turns.length + 1,
				startTimestamp: entry.timestamp,
				endTimestamp: entry.timestamp,
				startEntryId: entry.id,
				endEntryId: entry.id,
				userText: extractTextForSearch(entry.message) || "(no text)",
				assistantExcerpt: "",
				assistantMessageCount: 0,
				toolCalls: [],
				toolResults: [],
				toolErrorCount: 0,
				structuralEvents: [],
			};
			continue;
		}

		if (!currentTurn) {
			continue;
		}

		const turn = currentTurn;
		turn.endTimestamp = entry.timestamp ?? turn.endTimestamp;
		turn.endEntryId = entry.id ?? turn.endEntryId;

		if (entry.type !== "message") {
			turn.structuralEvents.push(entry.type);
			continue;
		}

		const message = entry.message;
		if (!message) continue;
		if (message.role === "assistant") {
			turn.assistantMessageCount += 1;
			const summary = summarizeMessageContent(message.content, {
				includeToolCallNames: true,
				includeThinking: false,
				imagePlaceholder: true,
			});
			if (summary.toolCalls.length) {
				turn.toolCalls.push(...summary.toolCalls);
			}
			const excerpt = summary.text || summary.placeholder || (summary.toolCalls.length ? `[tool calls: ${summary.toolCalls.join(", ")}]` : "");
			if (excerpt) {
				turn.assistantExcerpt = [turn.assistantExcerpt, excerpt].filter(Boolean).join(" ").trim();
			}
			continue;
		}

		if (message.role === "toolResult") {
			if (typeof message.toolName === "string") turn.toolResults.push(message.toolName);
			if (message.isError) turn.toolErrorCount += 1;
			continue;
		}

		if (message.role === "bashExecution") {
			turn.structuralEvents.push(`bashExecution:${excerptText(sanitizeOpaqueText(String(message.command ?? "(unknown command)")), 80)}`);
			if (typeof message.exitCode === "number" && message.exitCode !== 0) {
				turn.toolErrorCount += 1;
			}
			continue;
		}
	}

	if (currentTurn) turns.push(currentTurn);

	for (const turn of turns) {
		turn.toolCalls = unique(turn.toolCalls);
		turn.toolResults = unique(turn.toolResults);
		turn.structuralEvents = unique(turn.structuralEvents);
		turn.assistantExcerpt = turn.assistantExcerpt || "(no assistant text)";
	}

	return turns;
}

function normalizeEntry(entry: any) {
	const base = {
		entryId: entry?.id ?? "(unknown)",
		parentId: entry?.parentId ?? null,
		type: entry?.type ?? "(unknown)",
		timestamp: entry?.timestamp,
	};

	if (entry?.type === "message") {
		const message = entry.message ?? {};
		const role = typeof message.role === "string" ? message.role : undefined;
		if (role === "bashExecution") {
			return {
				...base,
				role,
				text: excerptText(sanitizeOpaqueText(String(message.output ?? "")), EXCERPT_CHARS),
				extra: `command=${excerptText(sanitizeOpaqueText(String(message.command ?? "?")), 120)}, exitCode=${message.exitCode ?? "?"}, cancelled=${Boolean(message.cancelled)}, truncated=${Boolean(message.truncated)}${message.fullOutputPath ? `, fullOutputPath=${message.fullOutputPath}` : ""}`,
			};
		}
		const summary = summarizeMessageContent(message.content, {
			includeToolCallNames: true,
			includeThinking: false,
			imagePlaceholder: true,
		});
		let text = summary.text || summary.placeholder || "";
		if (!text && role === "assistant" && summary.toolCalls.length) {
			text = `[tool calls: ${summary.toolCalls.join(", ")}]`;
		}
		return {
			...base,
			role,
			toolName: typeof message.toolName === "string" ? message.toolName : undefined,
			isError: typeof message.isError === "boolean" ? message.isError : undefined,
			text,
			summary: summary.toolCalls.length && role === "assistant" ? `toolCalls=${summary.toolCalls.join(", ")}` : undefined,
		};
	}

	if (entry?.type === "model_change") {
		return { ...base, extra: `${entry.provider ?? "?"}/${entry.modelId ?? "?"}` };
	}
	if (entry?.type === "thinking_level_change") {
		return { ...base, extra: String(entry.thinkingLevel ?? "?") };
	}
	if (entry?.type === "compaction") {
		return {
			...base,
			summary: typeof entry.summary === "string" ? entry.summary : "",
			extra: `firstKeptEntryId=${entry.firstKeptEntryId ?? "?"}, tokensBefore=${entry.tokensBefore ?? "?"}`,
		};
	}
	if (entry?.type === "branch_summary") {
		return {
			...base,
			summary: typeof entry.summary === "string" ? entry.summary : "",
			extra: `fromId=${entry.fromId ?? "?"}`,
		};
	}
	if (entry?.type === "custom") {
		return {
			...base,
			extra: `customType=${entry.customType ?? "?"}${entry.data && typeof entry.data === "object" ? `, dataKeys=${Object.keys(entry.data).join(",")}` : ""}`,
		};
	}
	if (entry?.type === "custom_message") {
		const summary = summarizeMessageContent(entry.content, {
			includeToolCallNames: false,
			includeThinking: false,
			imagePlaceholder: true,
		});
		return {
			...base,
			role: "custom",
			text: summary.text || summary.placeholder || "",
			extra: `customType=${entry.customType ?? "?"}, display=${Boolean(entry.display)}`,
		};
	}
	if (entry?.type === "label") {
		return { ...base, extra: `targetId=${entry.targetId ?? "?"}, label=${entry.label ?? ""}` };
	}
	if (entry?.type === "session_info") {
		return { ...base, extra: `name=${entry.name ?? ""}` };
	}

	return base;
}

function normalizeContextMessage(message: any, index: number) {
	const summary = summarizeMessageContent(message?.content, {
		includeToolCallNames: true,
		includeThinking: false,
		imagePlaceholder: true,
	});
	let text = summary.text || summary.placeholder || "";
	if (!text && message?.role === "assistant" && summary.toolCalls.length) {
		text = `[tool calls: ${summary.toolCalls.join(", ")}]`;
	}
	if (!text && message?.role === "toolResult" && typeof message.toolName === "string") {
		text = `[tool result: ${message.toolName}]`;
	}
	if (!text && message?.role === "bashExecution" && typeof message.command === "string") {
		text = `Ran ${sanitizeOpaqueText(message.command)}`;
	}
	if (!text && message?.role === "branchSummary" && typeof message.summary === "string") {
		text = message.summary;
	}
	if (!text && message?.role === "compactionSummary" && typeof message.summary === "string") {
		text = message.summary;
	}

	return {
		index,
		role: message?.role ?? "(unknown)",
		summary: excerptText(text || "(no text)", EXCERPT_CHARS),
	};
}

function formatModel(model: any): string {
	if (!model) return "(none)";
	if (typeof model.provider === "string" && typeof model.modelId === "string") {
		return `${model.provider}/${model.modelId}`;
	}
	if (typeof model.provider === "string" && typeof model.id === "string") {
		return `${model.provider}/${model.id}`;
	}
	return JSON.stringify(model);
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

function inferKindFromPath(path: string): SessionKind {
	const parts = normalizeRel(path).split("/").filter(Boolean);
	const bucketIndex = parts.findIndex((part) => SESSION_BUCKET_PATTERN.test(part));
	if (bucketIndex >= 0) {
		const remaining = parts.length - bucketIndex - 1;
		return remaining > 1 ? "nested" : "top-level";
	}
	return parts.length > 1 ? "nested" : "top-level";
}

function formatCountMap(counts: Record<string, number>): string {
	const entries = Object.entries(counts);
	if (!entries.length) return "(none)";
	return entries
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([key, value]) => `${key}:${value}`)
		.join(", ");
}

function excerptText(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars - 1)}…`;
}

function sanitizeOpaqueText(text: string): string {
	const normalized = text.trim();
	if (!normalized) return normalized;
	if (normalized.startsWith("data:")) {
		return `[opaque text omitted: data URL, ${normalized.length} chars]`;
	}
	const compact = normalized.replace(/\s+/g, "");
	if (compact.length >= 512 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
		return `[opaque text omitted: probable base64, ${compact.length} chars]`;
	}
	return normalized;
}

function sanitizeDetails(value: unknown): unknown {
	if (typeof value === "string") {
		return excerptText(sanitizeOpaqueText(value), 4000);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeDetails(item));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDetails(item)]));
	}
	return value;
}

function normalizeRel(pathValue: string): string {
	return pathValue.replace(/\\/g, "/");
}

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function serializeSession(session: DiscoveredSession) {
	return {
		sessionId: session.sessionId,
		path: session.path,
		cwd: session.cwd,
		name: session.name,
		parentSessionPath: session.parentSessionPath,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		kind: session.kind,
		relativePath: session.relativePath,
		nestingDepth: session.nestingDepth,
		topLevelSessionPath: session.topLevelSessionPath,
		topLevelSessionId: session.topLevelSessionId,
		nestedSessionCount: session.nestedSessionCount,
	};
}

function finalizeOutput(text: string, details: Record<string, unknown>) {
	const safeDetails = sanitizeDetails(details) as Record<string, unknown>;
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text: truncation.content, details: safeDetails };
	}

	const dir = mkdtempSync(join(tmpdir(), "pi-session-inspect-"));
	const fullOutputPath = join(dir, "output.txt");
	writeFileSync(fullOutputPath, text, "utf8");

	let finalText = truncation.content;
	finalText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	finalText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	finalText += ` Full output saved to: ${fullOutputPath}]`;

	return {
		text: finalText,
		details: {
			...safeDetails,
			truncation: truncation as TruncationResult,
			fullOutputPath,
		},
	};
}
