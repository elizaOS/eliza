# #13962 — drained-org 402 renders as a generic error (client half)

The SERVER half already merged (#13928): a 402 credit-exhaustion connector turn now classifies to `failureKind="insufficient_credits"` with the actionable top-up reply text. But the **client** still rendered `insufficient_credits` as a plain text bubble (`MessageContent.tsx` — it was excluded from the `no_provider` structured gate and fell through to `MessageTextBody`), so there was no designed "Out of credits" state and no top-up affordance — the UI three-state rule (#13962) was unmet.

## Fix
Add an exclusive `if (message.failureKind === "insufficient_credits")` branch right after the existing `no_provider` gate, mirroring it one-for-one: warn/orange-accented card with an "Out of credits" title, the server's actionable copy (`message.text`, muted), and a primary **"Add credits"** CTA wired to the existing `handleOpenSettings` (`setTab("settings")` — Cloud top-up lives under settings; there is no separate billing tab). Theme-aware, no blue, no server/credit arithmetic touched. Also removed the now-stale `no_provider` comment claiming insufficient_credits renders as text.

## Verification
Added a real test to `MessageContent.interactions.test.tsx` (vitest + @testing-library/react): renders a `failureKind:"insufficient_credits"` message, asserts the designed gate ("Out of credits" title + "Add credits" button + verbatim server copy, not a plain bubble), and that clicking "Add credits" calls `setTab("settings")`.

**Local test note:** the new test (and all 4 pre-existing tests in this file) currently crash locally on `useRef` from a **stale `dist/node_modules/react`** symlink in this checkout (a build-artifact/env issue — `vitest.config.ts` derives the React alias via `lucide-react` which resolves into the Jun-28 dist copy, mismatching the renderer's React 19.2.5). This is pre-existing and unrelated to the change (identical failure on the untouched tests); a fresh CI install resolves React correctly, so this PR's `ui-story-gate`/`test:client` CI verifies the test. The change is a one-for-one mirror of the proven-green `no_provider` gate.

## N/A
Full `audit:app` visual — this follows the existing `no_provider` gate's design one-for-one; a reviewer visual pass is welcome. Model-trajectory/audio — N/A.
