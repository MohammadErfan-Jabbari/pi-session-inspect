# session-inspect Pi extension

This directory is the source of truth for the v1 session inspection extension for Pi.

## Purpose

This extension gives agents a clean read-only surface for Pi session history.

It exists because Pi already stores rich session data, but the default agent-facing surface is weak for the workflows we actually use:
- recover prior context from a previous session
- audit what happened in a probe or setup session
- find session ids and file paths for the current repo
- search session history
- inspect nested subagent sessions that Pi's stock listing API misses

## Tool

The extension registers one tool:

- `session_inspect`

### Actions

#### `current`
Return the identity and location of the current session.

Returns:
- `sessionId`
- `sessionFile`
- `sessionName`
- `cwd`
- `persisted`
- `repoRoot`
- `suggestedTmpDir`
- `sessionsRoot`

`suggestedTmpDir` is advisory only. The extension does not create it.

This is the intended pairing for repo session-scoped scratch work:
- call `session_inspect({ action: "current" })`
- use the returned `suggestedTmpDir`
- by repo convention that usually means `tmp/sessions/<session-id>/`

#### `list`
Discover Pi sessions and return lightweight metadata.

Filters:
- `scope`: `cwd` | `repo` | `all`
- `kind`: `top-level` | `nested` | `all`
- `offset`
- `limit`

Defaults:
- `scope: repo`
- `kind: top-level`

#### `search`
Search sessions by text.

v1 search fields:
- session UUID
- session path
- session display name
- first user message
- flattened user and assistant text

This is intentionally lightweight. It is not a full transcript search engine.

#### `read`
Read one session by:
- `current`
- exact session file path
- exact session UUID
- unique UUID prefix

Views:
- `summary`
- `turns`
- `entries`
- `context`

## Views

### `summary`
Default read surface.

Use this for:
- previous-session recovery
- high-level audit
- current state / next-step reconstruction

### `turns`
Readable active-branch history grouped around user turns.

Use this for:
- continuity
- reviewing how a conversation progressed
- seeing tools and tool errors per turn without raw JSONL noise

### `entries`
Whole-file forensic view in append order.

Use this for:
- exact path inspection
- structural debugging
- labels, compaction entries, custom entries, and other non-message state

### `context`
Normalized `buildSessionContext()` view.

This is intentionally lossy and branch-only.

Use this only when the real question is:
- what would the model see on the active branch right now?

## Nested session support

This extension does its own recursive discovery.

That matters because Pi's stock `SessionManager.listAll()` only scans one directory level deep and misses nested subagent sessions on this machine.

The extension supports both Pi storage shapes that matter in practice:
- default bucketed layout: `<sessions-root>/<cwd-bucket>/<file>.jsonl`
- direct custom `sessionDir` layout: `<sessions-root>/<file>.jsonl`

Within either layout it classifies:
- `top-level` sessions
- `nested` sessions

For nested sessions it also tries to derive the owning top-level session path and top-level session id.

## Safety and scope

- Read-only by design.
- Target-session reads parse raw session files in memory instead of using mutating session-open paths.
- Does not switch sessions.
- Does not mutate session files.
- Does not create repo scratch directories such as `suggestedTmpDir` automatically.
- Does not add a database, daemon, or GUI.
- Avoids dumping raw base64 image payloads.
- Detailed views support pagination.
- Final output is truncated using Pi's normal truncation limits, with full output written to an OS temp file when needed.

## Important correctness notes

- Session UUIDs and entry ids are different ID domains. The extension keeps them separate.
- `context` is not a transcript view.
- Search is conversation-oriented, not a guarantee of full tool-result indexing.
- The extension prefers the active runtime session directory and current session ancestry to locate the active sessions root, then falls back to the default Pi agent dir.

## Deployment

The intended deployment shape is through the repo's local Pi package manifest.

This extension is loaded from:
- `package.json` -> `pi.extensions` -> `./systems/pi/extensions`

That keeps the authored source of truth in this repo instead of a standalone user-level symlink.
