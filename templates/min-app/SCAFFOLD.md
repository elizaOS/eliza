# Scaffold instructions for coding agents

You (the coding agent spawned by the Milady orchestrator) are responsible for turning this template into a working Eliza app. **Read this entire file before editing.**

## 1. Replace placeholders

Every file in this template contains one or both of:

- `__APP_NAME__` — the npm-style package name. Use lowercase, hyphenated. Scope it under `@elizaos/` for first-party apps, otherwise pick a sensible scope.
- `__APP_DISPLAY_NAME__` — the human-readable name shown in the dashboard.

Replace **all** occurrences in `package.json`, `index.html`, `src/`, `tests/`, and `README.md`. Do not leave a single placeholder behind — verification will fail.

## 2. Fill in real metadata

In `package.json`:

- Replace the placeholder `description` with one factual sentence about what the app does.
- Set `elizaos.app.category` to one of the canonical categories (`game`, `utility`, `productivity`, `social`, `creative`, `dev-tools`, `finance`, `media`).
- Replace `assets/hero.png` with a real hero image when you have one. The placeholder 1x1 PNG is intentional — do not delete it without a replacement.

## 3. Implement the actual feature

The default `helloAction` is only a smoke action. Add real actions, providers, and UI for whatever the user asked for. Keep one passing test in `tests/` that exercises the new code path.

## 4. Verify before signaling done

Run, in this order, from the app's package directory:

```bash
bun run typecheck
bun run lint
bun run test
```

All three must exit zero. If one fails, fix it. Do not silence errors with `as any`, `// @ts-ignore`, broad `try/catch`, or `?? defaultValue` patterns that hide missing data.

## 5. Signal completion

After verification passes, emit a single line on stdout:

```
APP_CREATE_DONE {"appName":"<__APP_NAME__>","files":["<list>"],"tests":{"passed":<n>,"failed":0},"lint":"ok","typecheck":"ok"}
```

The orchestrator will cross-check the claims against disk and the verification log. If anything you assert does not match reality, it will retry you with a structured failure report (capped by `MILADY_APP_VERIFICATION_MAX_RETRIES`, default `3`).

## Rules

- Single source of truth: derived state lives in the use case / action handler, not the React component.
- No business math in the React UI. Read DTO fields and format only.
- Logger over `console.*` for any runtime code (UI may use `console` for browser-side dev).
- DTO fields are required by default. No `?? 0` or `as` casts to skip missing data.
- Do not invent endpoints with no UI trigger.
