# pi-session-inspect

A read-only Pi extension for session discovery, search, and normalized session inspection.

It gives Pi agents a clean way to:
- identify the current Pi session
- list sessions for the current repo or across the active Pi session root
- search Pi session history
- read previous Pi sessions in normalized views
- inspect nested Pi subagent sessions that Pi's stock listing API can miss

This package is intentionally narrow. It is for **Pi sessions only**. It does not inspect Factory / Droid sessions or other harness session formats.

## Install

Install directly from GitHub with Pi:

```bash
pi install https://github.com/MohammadErfan-Jabbari/pi-session-inspect
```

Or try it for one run only:

```bash
pi -e https://github.com/MohammadErfan-Jabbari/pi-session-inspect
```

## What it adds

This package registers one tool:

- `session_inspect`

### Actions

- `current` — current session id, file, cwd, repo root, and suggested session-scoped tmp path
- `list` — discover Pi sessions by scope and kind
- `search` — search Pi sessions by text
- `read` — inspect one Pi session in normalized views

### Read views

- `summary` — high-level previous-session recovery and audit view
- `turns` — readable active-branch turn history
- `entries` — whole-file forensic entry view
- `context` — lossy active-branch model context view

## Why this exists

Pi already stores rich session history, but agents do not get a strong built-in tool for session review. This package fills that gap without adding a database, daemon, or GUI.

The extension is especially useful when you want an agent to:
- review a previous Pi session
- recover prior work from Pi session history
- find Pi session ids or file paths
- search Pi sessions in the current repo
- inspect nested Pi subagent sessions

## Session-scoped tmp pairing

This package returns a `suggestedTmpDir` from:

```ts
session_inspect({ action: "current" })
```

In repos that follow that convention, this usually points at:

```text
tmp/sessions/<session-id>/
```

The tool only suggests the path. It does not create it.

## Safety

- read-only by design
- target-session reads parse raw Pi session files in memory
- does not switch sessions
- does not mutate session files
- avoids dumping raw base64 image payloads by default
- supports nested Pi subagent sessions through recursive discovery

## Package layout

```text
pi-session-inspect/
├── extensions/
│   └── session-inspect/
│       ├── index.ts
│       ├── utils.ts
│       └── README.md
├── LICENSE
├── package.json
└── README.md
```

## License

MIT
