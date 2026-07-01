# Testing & evidence mandate — repo-wide rollout + state-of-testing audit

This documents a repo-wide documentation change that makes **recorded +
manually-reviewed model trajectories, real full-featured end-to-end tests
(screenshots + logs at every phase + a walkthrough video), and manual review of
every produced artifact** a non-negotiable, restated in **every** package's
`CLAUDE.md` / `AGENTS.md`. It also records the audit that motivated it.

## What changed

- **`PR_EVIDENCE.md`** (canonical standard) strengthened: added the **three laws
  of done** (prove-it-real *and* review it by hand · test everything for real,
  no larp · no residuals / hard path), a **"Capturing is not reviewing"**
  section, a **Domain artifacts** evidence row (memory/knowledge/DB/scheduled
  tasks/wallet/on-chain/files), a **§4 Real tests — no larp**, a **§5 No
  residuals — finish the whole thing**, an expanded completeness gate, and a
  **§7 per-area evidence cheat-sheet**.
- **Root `CLAUDE.md` / `AGENTS.md`**: Definition-of-Done expanded with the three
  laws + domain artifacts + "run native features on the real device matrix."
- **A non-negotiable mandate block inserted into every package/plugin
  `CLAUDE.md` and mirrored byte-identical to `AGENTS.md`** — marker-guarded
  (`evidence-and-e2e-mandate`), with a correct relative link back to
  `PR_EVIDENCE.md` and an **archetype-tailored "Capture & manually review for
  this package"** list (what real artifacts that specific kind of package must
  produce and a reviewer must inspect).
- **35 runnable examples** and **13 first-party dirs that were missing docs**
  (`packages/test*`, `plugin-vision`, `plugin-ngrok`, `plugin-vector-browser`,
  `packages/cloud/services/*`) got real, newly-authored `CLAUDE.md` + `AGENTS.md`
  carrying the same mandate.

### Coverage (283 package dirs + root)

| archetype | dirs | archetype | dirs |
| --- | --- | --- | --- |
| benchmark | 54 | example | 35 |
| native / on-device | 44 | connector | 28 |
| CLI / tooling | 26 | cloud backend / security | 16 |
| agent behavior / app plugin | 16 | model provider | 16 |
| storage / memory | 10 | wallet / chain / contracts | 9 |
| framework / runtime | 8 | eval / trajectory harness | 7 |
| voice / audio | 5 | UI surface | 4 |
| docs / site | 3 | OS / device image | 2 |

Each block hammers: **record AND read model trajectories** (live LLM, not the
proxy/mock); **real full-featured e2e — no larp** (error/edge/empty/concurrency/
role/adversarial paths, not the front door; if the real dep is hard to reach,
make it reachable); **screenshots + logs at every phase + a complete walkthrough
video**; **manually review every artifact** (client logs, server logs,
trajectories, screenshots, and the domain artifacts for that package); and **no
residuals / no shortcuts — clear blockers by the hard path, finish everything.**

## Why — state-of-testing audit (real, file-cited)

A fan-out of subagents audited the actual test code. The finding is uniform and
matches the standing issue backlog: **the default PR/CI lane is almost entirely
mocks; real e2e exists but is gated off the PR path; tests assert routing/shape,
not outcomes; on-device and cross-platform are unverified.**

**core / agent / app-core / scenario-runner** — Default `bun run test` is 100%
unit mocks; real tests are *excluded* via `VITEST_EXCLUDE_REAL_E2E=1` /
`VITEST_EXCLUDE_REAL=1` (`run-all-tests.mjs` ~726). Live AgentRuntime+LLM tests
(`*.live.test.ts`, `*.real.test.ts`, `test/live-agent/*.e2e.test.ts`) and the
686-file scenario corpus are live-only/off-path. Coverage floor is **1% and
never enforced** (`run-vitest.mjs` never passes `--coverage`). Memory/DB outcomes
(rows, embeddings, relationships, scheduled tasks) are never asserted in the unit
lane. (→ #9943, #9949, #9956, #9970)

**model providers (9 plugins)** — Mock-only in PR CI; `*.live.test.ts` skip
without keys, `*.real.test.ts` are nightly (`TEST_LANE=post-merge`); harness
tests use the deterministic mock-LLM proxy, not a live model. Error paths (bad
key, model-not-found, 429, timeout, oversized context, mid-stream disconnect)
are never tested; no latency/token-usage captured. `plugin-groq` has zero live
tests; `plugin-embeddings` is mock-only; `plugin-local-inference`'s 42 tests are
all mocked (on-device inference never verified). (→ #9943, #9580)

**connectors (8 plugins)** — 84 unit files, 100% `vi.fn()` mocks. Only Discord +
Telegram have a real-runtime harness, and it's **excluded from CI**. 6/8
(Farcaster, Slack, X, WhatsApp, iMessage, Signal) have **zero** real e2e. No
connector ever drives a real inbound→agent→outbound loop in CI; threading,
reactions, attachments, multi-account, error/rate-limit paths untested;
scenario-runner has zero connector scenarios. (→ #9943, #9947)

**cloud backend + security** — Hybrid: integration tests boot real `wrangler dev`
+ PGlite, but the base `ci.yaml` **skips cloud entirely** (only path-gated
`cloud-tests.yml`). MCP registry CRUD writes are `describe.skip` (workerd+PGlite
500 on `INSERT…RETURNING`). Multi-tenant isolation has only ~3 cross-org
assertions and no RBAC matrix; wallet-signing routes test only to the boundary;
DB migrations are structurally validated but never run up/down; tests accept 3+
status codes instead of asserting the specific denial. (→ #9853, #9948, #9964,
#9943)

**app / ui / tui + e2e infra** — 110 Playwright ui-smoke specs **HTTP-mock every
endpoint** (`page.route`); no real backend model invocation even on happy paths;
keyless-debt hard-capped at 3. Voice uses scripted browser STT, not real audio
(no noise/overlap/barge-in); gesture e2e asserts a mock overlay, not real
touch/drag/detent; native-plugin tests mock the Capacitor bridge in desktop
Chromium (no real Kotlin/Swift, device lifecycle, permissions). Wallet/Character/
Browser/Workflow tested desktop-only, no portrait/landscape. (→ #9950, #9954,
#9957, #9967, #9958, #9970)

**benchmarks / eval (43 suites)** — Only 8/43 run on a real model (weekly); 30
are smoke-only with mock/fixture harnesses; adapter tests monkeypatch
`subprocess.Popen`/HTTP and never spawn a real runtime. No CI-gated
precision/recall/latency benchmark for the real memory-recall + knowledge
pipeline; a PR can break a harness without failing. (→ #9956, #9943, #9475,
#9958, #9960)

**native / on-device & agent-behavior** (covered via the UI/native and
personal-assistant findings): on-device bridges are exercised only against a
mocked Capacitor bridge in desktop Chromium — actual device logs, permissions,
and Android pause/resume / iOS app-intents are absent (#9967, #9580);
agent-behavior scenarios (inbox/calendar/email) step through routes to prove a
route exists but **don't assert the memory/sync/scheduled-task outcome** (#9970).

## Open issues this addresses (the documentation half)

#9943, #9949, #9950, #9954, #9956, #9957, #9958, #9960, #9964, #9967, #9970,
#9580, #9853, #9948, #9947. These are *code* fixes; this change makes the bar
that prevents their recurrence explicit and unavoidable in every package's
contributor docs.

## How to verify this change (no code-reading required)

```bash
# Every package/plugin CLAUDE.md carries the marker, and AGENTS.md is identical:
git grep -L "evidence-and-e2e-mandate" -- '**/CLAUDE.md'   # expect: none (besides vendored/excluded)
for f in $(git ls-files '**/CLAUDE.md'); do d=$(dirname "$f"); diff -q "$f" "$d/AGENTS.md" >/dev/null || echo "DIFFER $d"; done
# The canonical standard:
sed -n '12,30p' PR_EVIDENCE.md            # the three laws
```

> Note: the working tree also contained unrelated in-flight changes
> (`packages/ui/.../__e2e__/` captures, the `llama.cpp` submodule, untracked
> `packages/cloud-sdk/` + `packages/robot/`). This change is **markdown-only**
> and was staged file-by-file from the known target lists so none of that
> in-flight work was swept in.
