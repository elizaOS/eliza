# Scaffold instructions for coding agents

You (the coding agent spawned by the Milady orchestrator) are responsible for turning this template into a working Eliza plugin. **Read this entire file before editing.**

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

The default `helloAction` and `infoProvider` are smoke implementations. Add the real actions, providers, services, and types for whatever the user asked for. Keep at least one passing test in `tests/` per real action you add.

## 4. Verify before signaling done

Run, in this order, from the plugin's package directory:

```bash
bun run typecheck
bun run lint
bun run test
```

All three must exit zero. If one fails, fix it. Do not silence errors with `as any`, `// @ts-ignore`, broad `try/catch`, or `?? defaultValue` patterns that hide missing data.

## 5. Signal completion

After verification passes, emit a single line on stdout:

```
PLUGIN_CREATE_DONE {"name":"<__PLUGIN_NAME__>","files":["<list>"],"testsPassed":<n>,"lintClean":true,"description":"<one factual sentence>"}
```

Field contract (all required except `description`):

- `name` — string, the npm-style package name you used in `package.json`.
- `files` — array of repo-relative paths you created or modified.
- `testsPassed` — non-negative number of tests that passed in step 4.
- `lintClean` — boolean. `true` only when `bun run lint` exited zero with no warnings.
- `description` — optional one-sentence summary of what the plugin does.

The orchestrator will cross-check the claims against disk and the verification log. If anything you assert does not match reality, it will retry you with a structured failure report (capped by `MILADY_APP_VERIFICATION_MAX_RETRIES`, default `3`).

## Rules

- Actions, providers, and evaluators belong in their own files under `src/actions/`, `src/providers/`, `src/evaluators/`. The plugin barrel is wiring only.
- No business logic in the plugin barrel.
- Logger over `console.*` in any runtime code.
- Strong types only. No `any`, no `unknown` without a validating boundary, no `as` escapes, no `?? defaultValue` for missing required data.
- One canonical codepath per behavior. Do not add fallbacks for "old shape vs new shape" — pick one shape.
