# Scaffold instructions for coding agents

You (the coding agent spawned by the Eliza orchestrator) are responsible for turning this template into a working Eliza plugin. **Read this entire file before editing.**

## 1. Replace placeholders

Every file in this template contains one or both of:

- `__PLUGIN_NAME__` — the npm-style package name. Use lowercase, hyphenated. Scope under `@elizaos/plugin-` for first-party plugins, otherwise pick a sensible scope (`@user/plugin-foo`).
- `__PLUGIN_DISPLAY_NAME__` — the human-readable display name shown in the dashboard.

Replace **all** occurrences in `package.json`, `src/`, `tests/`, and `README.md`. Do not leave a single placeholder behind — verification will fail.

## 2. Fill in real metadata

In `package.json`:

- Replace the placeholder `description` with one factual sentence about what the plugin does.
- Set `elizaos.plugin.category` to one of the canonical categories (`utility`, `ai-provider`, `connector`, `dev-tools`, `data`, `media`, `social`).

## 3. Implement the actual feature

The default `infoProvider` is a smoke implementation. Add real actions, providers, services, and types for whatever the user asked for. Keep at least one passing test in `tests/` per real action you add.

## 4. Verify before signaling done

Install the scaffold's declared dependencies once:

```bash
bun install
```

Run, in this order, from the plugin's package directory:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

All four must exit zero. If the plugin declares a view, the build must produce every declared `bundlePath` or `framePath` under `dist/`; a successful source-only compile is not a loadable view. If one command fails, fix it. Do not silence errors with unsafe casts to `any`, `// @ts-ignore`, broad `try/catch`, or `?? defaultValue` patterns that hide missing data.

## 5. Signal completion

After verification passes, emit a single line on stdout:

```
PLUGIN_CREATE_DONE {"pluginName":"<__PLUGIN_NAME__>","files":["<list>"],"tests":{"passed":<n>,"failed":0},"lint":"ok","typecheck":"ok","description":"<one factual sentence>"}
```

Field contract (all required except `description`):

- `pluginName` — string, the npm-style package name you used in `package.json`.
- `files` — array of repo-relative paths you created or modified.
- `tests` — object with the exact Vitest count: `passed` is the verified passed count and `failed` must be `0`.
- `lint` — literal `"ok"`, only after `bun run lint` exits zero.
- `typecheck` — literal `"ok"`, only after `bun run typecheck` exits zero.
- `description` — optional one-sentence summary of what the plugin does.

Do not emit legacy fields such as `name`, `testsPassed`, or `lintClean`; the orchestrator rejects them.

The orchestrator will cross-check the claims against disk and the verification log. If anything you assert does not match reality, it will retry you with a structured failure report (capped by `ELIZA_APP_VERIFICATION_MAX_RETRIES`, default `3`).

## 6. VIEW_KIND_CONTRACT (only if your plugin adds a view)

If your plugin contributes a UI view (a `Plugin.views` entry), set its `viewKind`
so the shell knows when to show it. The four kinds (escalating exposure):

- `system` — core, always-present views (reserved for built-ins; don't use).
- `release` — public, production-ready, always visible. **Default for a finished view.**
- `developer` — dev tooling (logs, inspectors); shown in dev builds, hidden in prod until enabled in Settings.
- `preview` — unfinished / experimental; hidden on every build until enabled in Settings.

Choose `release` for a complete, user-facing view; `preview` for an early/experimental one.
If you omit `viewKind`, it defaults to `release`.

## Rules

- Actions, providers, and evaluators belong in their own files under `src/actions/`, `src/providers/`, `src/evaluators/`. The plugin barrel is wiring only.
- No business logic in the plugin barrel.
- Logger over `console.*` in any runtime code.
- Strong types only. No `any`, no `unknown` without a validating boundary, no `as` escapes, no `?? defaultValue` for missing required data.
- One canonical codepath per behavior. Do not add fallbacks for "old shape vs new shape" — pick one shape.
