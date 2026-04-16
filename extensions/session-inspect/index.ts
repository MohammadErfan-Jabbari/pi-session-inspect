import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
	ACTION_VALUES,
	KIND_VALUES,
	SCOPE_VALUES,
	VIEW_VALUES,
	discoverSessions,
	filterSessions,
	formatCurrentSession,
	formatListResult,
	formatSearchResult,
	getCurrentSessionInfo,
	paginate,
	readSessionView,
	resolveScope,
	resolveSessionSpecifier,
	searchSessions,
} from "./utils";

const TOOL_GUIDELINES = [
	"Use this tool when the user asks to inspect a previous Pi session, recover prior work, audit what happened, find session ids or file paths, or search session history.",
	"Prefer scope repo for work tied to the current repository. Use scope all only when the user clearly wants cross-repo discovery.",
	"Use view summary for recovery, turns for readable branch history, entries for forensics, and context only when you specifically need the lossy active-branch model context.",
];

const TOOL_PARAMS = Type.Object({
	action: StringEnum(ACTION_VALUES),
	scope: Type.Optional(StringEnum(SCOPE_VALUES)),
	kind: Type.Optional(StringEnum(KIND_VALUES)),
	session: Type.Optional(
		Type.String({
			description: 'Target session. Use "current", an absolute session path, a full session UUID, or a unique UUID prefix.',
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "Text query for session search. Search covers session ids, paths, names, first messages, and flattened user/assistant text.",
		}),
	),
	view: Type.Optional(StringEnum(VIEW_VALUES)),
	offset: Type.Optional(Type.Number({ description: "Pagination offset for list/search/read detailed views. Defaults to 0." })),
	limit: Type.Optional(Type.Number({ description: "Pagination limit. Defaults to 10 for list/search and 20 for detailed reads." })),
});

export default function sessionInspectExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_inspect",
		label: "Session Inspect",
		description: `Inspect Pi session history. Supports current session identity, session discovery, text search, and normalized session reads. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Inspect Pi session identity and history: find sessions by repo or globally, search session text, and read normalized previous-session views.",
		promptGuidelines: TOOL_GUIDELINES,
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = await getCurrentSessionInfo(ctx.cwd, ctx.sessionManager);

			if (params.action === "current") {
				const result = formatCurrentSession(current);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			}

			const sessions = await discoverSessions(current.sessionsRoot);

			if (params.action === "list") {
				const scope = resolveScope(ctx.cwd, params.scope);
				const filtered = filterSessions(sessions, ctx.cwd, scope, params.kind);
				const pagination = paginate(filtered, params.offset, params.limit, 10);
				const result = formatListResult(filtered, pagination, scope, params.kind);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			}

			if (params.action === "search") {
				if (!params.query || !params.query.trim()) {
					throw new Error("session_inspect search requires a non-empty query");
				}
				const scope = resolveScope(ctx.cwd, params.scope);
				const filtered = filterSessions(sessions, ctx.cwd, scope, params.kind);
				const matches = searchSessions(filtered, params.query);
				const pagination = paginate(matches, params.offset, params.limit, 10);
				const result = formatSearchResult(matches, pagination, scope, params.kind, params.query);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			}

			const sessionPath = resolveSessionSpecifier(params.session, current.sessionFile, sessions, ctx.cwd);
			const result = readSessionView(sessionPath, params.view, params.offset, params.limit, sessions);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});
}
