# 10322 — Device remote-connect-at-URL onboarding (deep link + Settings)

Closes #10322. Follow-up to #9952 / #10302 (the in-chat onboarding redesign that
removed the remote-connect-at-URL surface and quarantined the two device lanes).

## What changed

Device/desktop "connect to a remote agent at a URL" onboarding is restored as a
first-class capability that is **decoupled from the onboarding surface**, so it
works whether onboarding is the old full-screen flow or the new in-chat
conductor — and survives future onboarding redesigns.

| Surface | Before (#9952/#10302) | After |
| --- | --- | --- |
| Deep link | `<scheme>://first-run/runtime/remote` only **pre-selected** the runtime; the URL had to be typed into a now-deleted DOM field | `<scheme>://first-run/runtime/remote?api=<url>` **carries the URL** and connects + completes first-run |
| Settings → Runtime → Remote | `reloadIntoFirstRunRuntime("remote")` → dead-ends in the conductor (no remote URL capture) | Opens a **"Connect a remote agent"** URL + optional-token form |
| `finishRemote` | unreachable in `first-run-finish.ts` | capability **relocated** to the reusable headless `adopt-remote-first-run.ts` |
| Android lane | quarantined (`test.skip`) | **live**, drives the real `adb` VIEW-intent deep link |
| iOS lane | self-skips (`phase: "skipped"`) | **live**, harness fires `simctl openurl`; in-app verifier proves home |

Both the deep link and the Settings entry funnel through the existing,
security-hardened `CONNECT_EVENT` path (`applyLaunchConnection` +
`url-trust-policy`); a bearer token is **never** accepted from an OS-delivered
deep link.

### Completion semantics (the lynchpin)

`applyLaunchConnection({ kind: "remote" })` only points the client at the remote;
it does **not** complete first-run. `adopt-remote-first-run.ts` PROBES the
remote's `GET /api/first-run/status` and only `POST`s `/api/first-run` when the
host has not finished its own first-run — an improvement over the legacy
unconditional `finishRemote` POST, which could clobber an already-configured
host's deployment target. `retryStartup()` then re-polls and lands on home.

## Verification done locally (this branch, rebased onto post-#10302 develop)

- **Unit tests — `bun run --cwd packages/ui test` (filtered): 36 passed.**
  - `src/first-run/__tests__/deep-link-entry.test.ts` — `parseFirstRunRemoteConnectDeepLink`:
    api/apiBase/url/host aliases, percent-decoding, bare-remote → null (falls
    through to pre-select), local/cloud → null, foreign scheme/host → null,
    malformed → null, empty `api` → null.
  - `src/first-run/adopt-remote-first-run.test.ts` — `normalizeRemoteAgentUrl`
    (trailing-slash/query/hash strip, bare-host → https, empty/non-http reject)
    and `adoptRemoteAgentFirstRun` (fresh host → POST `{deploymentTarget.runtime:"remote"}`,
    already-complete → no POST/no clobber, unreachable probe → still POSTs,
    POST failure → propagates, token forwarded).
- **No regressions** — `packages/ui` first-run + shell suite: 143 passed (13
  files); `packages/app` deep-link suite: 19 passed.
- **Typecheck** — `packages/ui` and `packages/app` clean for every touched file.
  (Only pre-existing, unrelated `src/cloud/billing/wallet/steward-wallet-providers.tsx`
  viem `Config` generic error remains; that file is unmodified by this branch
  and errors identically on `develop`.)
- **Lint** — Biome could not run locally: the repo pins `@biomejs/biome@2.5.0`
  but this worktree's shared store has only 2.4.x, which rejects the root
  `biome.json` `css.parser.tailwindDirectives` key. Code follows Biome defaults
  (double quotes, 2-space, trailing commas, import sort); CI runs 2.5.0.

## Device e2e — real OS deep link (runs in CI / on device hardware)

These lanes need a booted emulator/simulator + the deterministic host agent
(`serve-real-local-agent.ts`), so they execute in CI, not in this sandbox. They
were rewritten to drive the **real** path and produce the screenshots + video:

- **iOS** — `.github/workflows/mobile-build-smoke.yml` → `node packages/app/scripts/ios-onboarding-smoke.mjs`.
  Harness fires `simctl openurl <scheme>://first-run/runtime/remote?api=http://127.0.0.1:31337`;
  the in-app verifier asserts `home-launcher-surface[data-page=home]` +
  `chat-composer-textarea` + persisted `elizaos:active-server`. Artifacts:
  `fresh-onboarding.png`, `home-landing.png`, `onboarding-to-home.mp4`,
  `result.json` (uploaded as the `ios-onboarding-to-home` artifact).
- **Android** — `bun run --cwd packages/app test:e2e:android:onboarding`.
  Fires `adb am start -a VIEW -c BROWSABLE -d <scheme>://first-run/runtime/remote?api=…`;
  asserts the same home surface + `"kind":"remote"` active-server. Artifacts:
  `home-landing.png`, `onboarding-to-home.mp4`.

## Aesthetic review — Settings → Runtime → "Connect a remote agent"

- Reuses canonical primitives only: `SettingsRow` (stacked), `Input`,
  `SettingsActionButton`. No new base elements.
- Brand-compliant: no blue; error text uses the established `text-destructive`
  token; the Connect button is the standard accent action button; the form is a
  neutral stacked row under the Remote runtime card.
- States covered: empty (Connect disabled until a URL is entered), invalid URL
  (inline `role="alert"` message from `normalizeRemoteAgentUrl`), optional token
  field (password input). Desktop + mobile share the `SettingsRow stacked`
  layout.
- Full-page rest/hover screenshots for this row are produced by
  `bun run --cwd packages/app audit:app` (Settings → Runtime), which boots the
  real shell — run in the app visual-audit lane.

## Trajectory / audio — N/A

This is shell/first-run UX wiring (deep-link routing + a connect form), not an
agent action / prompt / model change, so there is no model trajectory or
voice round-trip to capture (consistent with the #9952 evidence section).
