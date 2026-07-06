# Definition of Done — sync, PR, and human-verifiable evidence

This is the repo-wide standard for shipping work in the elizaOS monorepo. It
applies to **every** fix, feature, refactor, and doc change, in every package
and plugin. The bar is simple to state:

> A reviewer must be able to confirm the change works **without reading the
> code** — by watching it happen and inspecting the artifacts you attached.

If a human can't verify it from the evidence, it isn't done.

## The three laws of "done"

Everything below expands these. If you remember nothing else, remember these:

1. **Prove the real thing happened — and look at it yourself.** Record the
   actual model trajectories (inputs *and* outputs), the real logs, the real
   pixels, the real on-chain/DB/memory state — from a **live** system, never a
   mock asserting itself green. Then **open every artifact and review it by
   hand.** Capturing is not reviewing; a green check is not proof.
2. **Test everything for real — no larp.** Every change ships detailed,
   full-featured end-to-end tests that drive the *real* path. Not the happy
   "front door" — error paths, edges, empty/invalid input, concurrency,
   roles/permissions, and adversarial input. A test that asserts against a
   mock/stub/fixture standing in for the thing under test does not count.
3. **No residuals, no shortcuts.** The goal is not "done," it is *everything*
   done. Clear blockers by the hard path — build the real architecture, stand
   up the real model/device/service, actually test it. No TODOs, no stubs, no
   stepping-stones, no "follow-ups." Keep going until every possibility is
   exhausted.

---

## 1. Always ship through a PR

Never push feature/fix work straight to `develop`. Work on a branch and open a
PR against `develop`.

- Branch naming: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`.
- Open an issue first for anything non-trivial (see `CONTRIBUTING` /
  root `README.md`), and link it in the PR's **Relates to** section.
- One logical change per PR. Keep diffs reviewable.

## 2. Always sync with the latest `develop` before opening or updating a PR

Your branch must be in sync with `develop` and **conflict-free** at all times —
not just at creation, but every time you push.

```bash
git fetch origin
git rebase origin/develop        # preferred — linear history
# (or)  git merge origin/develop  # if the branch is shared/already reviewed
# resolve every conflict, then:
bun install                       # lockfile/submodules may have moved
bun run verify                    # typecheck + lint must pass post-merge
git push --force-with-lease       # only after a rebase
```

Rules:

- Re-sync immediately when `develop` moves and **before requesting review or
  merging**. A PR that can't fast-forward onto `develop` is not ready.
- Resolve conflicts deliberately — never `-X theirs/ours` blindly across the
  tree. Re-run `bun run verify` and the relevant tests after resolving.
- If a `develop` change invalidated your evidence (different UI, different log
  lines, different trajectory), **re-capture the evidence**. Stale evidence is
  worse than none.

## 3. Attach complete, human-verifiable evidence to every PR

Every PR includes the evidence below that applies to it. "Doesn't apply" is a
valid answer for a given row — but you must say so explicitly in the PR, not
leave it blank.

| Evidence | Required when the change touches… | How to produce it | Where it goes |
| --- | --- | --- | --- |
| **Real LLM-call trajectory** | agent behavior, actions, providers, prompts, models | `scenario-runner` against a **live** LLM (not the deterministic proxy) — JSON report + run viewer + native jsonl | report attached to the PR + key excerpts pasted inline |
| **Backend logs** | runtime, API, services, schedulers | structured logger output (`[ClassName] …`) showing the code path firing end to end | pasted inline in the PR (`<details>` block when long) |
| **Frontend logs** | any UI / client | browser console + network trace showing the request/response and state change | pasted inline in the PR |
| **Full-page screenshots** | any UI change | `audit:app` (app) / `audit:cloud` (cloud-frontend) or `test:e2e:record` sheets; before **and** after; desktop **and** mobile; portrait **and** landscape | attached inline in the PR (JPG) |
| **Video walkthrough** | any user-facing flow | `bun run test:e2e:record` (records the run) — a full click-through of the feature, start to finish | attached inline in the PR (MP4 — renders in GitHub) |
| **Audio/voice walkthrough** | voice, transcript, TTS/STT, kokoro | captured audio of the real round-trip + a narrated walkthrough | attached inline (MP4/M4A); if hosted externally, inline JPG still + link |
| **Domain artifacts** | memory, knowledge, DB, wallet/chain, scheduled tasks, files, devices | the *things the change produced* — memory rows, embeddings, knowledge, DB rows, scheduled-task records, relationships, wallet balance before/after, on-chain tx hashes + explorer links, generated files, device output — inspected by hand | pasted/screenshotted inline in the PR |

The point of all of them is the same: **prove the real thing happened.** Real
model calls, real log lines, real pixels, real audio, real chain/DB/memory
state — not a description of what should happen, not a unit test asserting a
mock.

### Capturing is not reviewing

Producing an artifact is half the job. The other half is **opening it and
checking it with your own eyes**, and saying in the PR what you saw:

- **Trajectories:** read the prompt, the providers/context, the raw model
  output, and every tool/action call. Did the model actually do the thing, for
  the right reason, with the right arguments? A captured-but-unread trajectory
  is not evidence.
- **Logs:** confirm the *specific* code path fired (the `[ClassName] …` lines
  you expect), not just that the process ran.
- **Screenshots/video:** confirm the real states render — empty, loading,
  error, and permission-denied, not only the populated happy path.
- **Domain artifacts:** open the DB rows / memories / knowledge / scheduled
  tasks / wallet balance / on-chain result and confirm the shape and values are
  what the feature claims. "The test passed" tells you nothing about whether the
  *data* is correct.

### The tools that produce this evidence (all already in the repo)

```bash
# Real-LLM agent trajectories (boots a real AgentRuntime + live LLM, emits a
# JSON report + a self-contained run viewer + training-corpus jsonl):
packages/scenario-runner/bin/eliza-scenarios run <scenario.ts> --report <out.json>
#   src: packages/scenario-runner — see its CLAUDE.md. Use a live model, not the
#   deterministic proxy, when the trajectory IS the evidence.

# End-to-end UI recordings (video + contact sheets + a browsable viewer):
bun run test:matrix:review               # full matrix + manifest + reviewer popup
bun run test:matrix                      # full matrix + manifest, no browser open
bun run test:e2e:record                  # scripts/e2e-recordings/run-all.mjs
bun run test:e2e:record:review           # recordings + local evidence dashboard
bun run test:e2e:record:sheets           # regenerate contact sheets + viewer
bun run test:e2e:audit-ui                # coverage of which routes are recorded

# Local manual evidence reviewer: scans screenshots, videos, logs, reports, and
# trajectories, computes screenshot color heuristics, runs packaged OCR by
# default, and opens evidence/index.html for the required hand review pass.
bun run evidence:review
bun run evidence:review:no-open

# Human-speed headed app playback with video enabled, useful when reviewing
# hover/focus/keyboard states while preserving the recorded artifact trail.
bun run test:watch-human

# App per-route screenshots (desktop + mobile, rest + hover), with a
# manual-review verdict stub per page — REQUIRED for app UI changes:
bun run --cwd packages/app audit:app

# Per-platform capture for native/mobile/desktop changes (build + redeploy
# first — these screenshot whatever is already installed, they do not build):
bun run --cwd packages/app capture:ios-sim
bun run --cwd packages/app capture:android-emu
bun run --cwd packages/app capture:linux-desktop
bun run --cwd packages/app capture:windows-desktop
```

### Where evidence goes: inline in the issue/PR

Evidence attaches **directly to the GitHub issue/PR** — drag-and-drop into the
description or a comment — so a reviewer sees the proof next to the change it
proves. Do **not** commit evidence files to the repo: the old
`.github/issue-evidence/` directory is retired (it bloated the repo and
detached the proof from the conversation it belonged to).

- **Video: MP4 only.** GitHub renders MP4 inline in issues/PRs; `.mov` /
  `.webm` often won't. Convert:
  `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p out.mp4`. Compress to fit
  GitHub's upload limit; if a video genuinely can't fit, host it, link it, and
  attach a representative JPG still inline so the proof survives link rot.
- **Screenshots: JPG preferred over PNG** — smaller and faster to load in
  review. Use PNG only when fine text or pixel-level UI detail would be lost.
- **Logs:** paste inline; wrap long output in a collapsible `<details>` block.
- **Scenario reports / run viewers:** attach the JSON (zip if needed) to the
  PR, paste the key trajectory excerpts inline, and note the exact command that
  regenerates the report.
- App audit output stays where the tool writes it
  (`packages/app/aesthetic-audit-output/` — fill `manual-review/<slug>.md` per
  page; no page may stay `needs-work` / `broken`); attach the relevant pages to
  the PR as JPG.

## 4. Real tests — no larp, no front-door-only

A passing test suite is necessary, not sufficient. Green CI does **not**
guarantee tested (see the standing backlog: #9943, #9950, #9954, #9958, #9967,
#9970). The tests you ship must be **real** and **thorough**:

- **Exercise the real thing, not a mock of it.** A test that swaps the model,
  device, chain, connector, or DB for a stub and then asserts the stub responded
  is not a test of your feature — it is a test of your mock. If the real
  dependency is hard to reach, *make it reachable*: that is the work.
- **Assert outcomes, not routing.** "An action was selected" / "the request was
  forwarded" is not the same as "the right thing happened." Assert the resulting
  state, output, and side effects.
- **Cover the whole surface, not the front door.** Happy path **and** error
  paths, empty/invalid/oversized input, concurrency and races, role/permission
  gating (including the denied path), timeouts/retries/rate-limits, and
  adversarial input. Fuzz where interleaving matters.
- **Make the test gate the PR.** A spec that exists but never runs on the PR
  path, or a coverage floor that is "advisory," is not protection. Wire it into
  the lane that actually blocks merge.
- **On-device / cross-platform means on-device / cross-platform.** A native or
  voice feature "tested" only in desktop Chromium against a mocked bridge, or
  only on Linux-x64-synthetic audio, is unverified. Run it on the real device /
  simulator / platform matrix.

If you discover the existing tests for the area you touched are shallow or
mocked, **fixing them is part of your change**, not a separate ticket.

## 5. No residuals — finish the whole thing

The goal is not "my part is done." The goal is *everything* done.

- **No TODOs, stubs, stepping-stones, or "follow-ups" left behind.** If it needs
  doing for the feature to be real, do it now.
- **Resolve blockers by the hard path.** If the model isn't wired up, wire it
  up. If the architecture is wrong, fix the architecture. If the thing can't be
  tested, make it testable. Don't route around a blocker with a mock or a
  narrower scope.
- **When in doubt, research, weigh, and ship the best version.** Don't guess and
  don't ship the first thing that compiles. Investigate the options, pick the
  highest-effort production-ready one, and build that — not a placeholder you
  intend to replace later.
- **Clean up what you touched.** Dead code, orphaned widgets, stale config, and
  half-migrations are residuals. Remove them.

## 6. Completeness & carefulness gate (before you mark a PR ready)

- [ ] Branch rebased/merged onto the **latest** `origin/develop`; **zero conflicts**.
- [ ] `bun run verify` (typecheck + lint) passes.
- [ ] Relevant tests pass (`bun run test`, or the scoped `--cwd <pkg> test`) — and they are **real** tests per §4, not mocks asserting themselves.
- [ ] For agent/LLM behavior: a **real-LLM** trajectory is attached **and you read it**, and it matches the claim.
- [ ] Backend and/or frontend logs attached, showing the actual code path firing.
- [ ] For UI: before/after full-page screenshots (desktop + mobile) + a video walkthrough; non-happy states shown.
- [ ] For voice/audio: captured audio of the real round-trip + a narrated walkthrough.
- [ ] For native/on-device: captured on the real device/simulator/platform matrix, build confirmed as yours.
- [ ] **Domain artifacts** (memory/knowledge/DB/scheduled-task/wallet/on-chain/files) inspected by hand and shown.
- [ ] Every evidence row above is either attached **or** explicitly marked N/A with a reason.
- [ ] No residuals: no TODOs/stubs/stepping-stones/dead code left; blockers resolved, not routed around.
- [ ] The PR description tells a reviewer exactly what to watch/read to confirm it — no code-reading required.
- [ ] If `develop` moved and changed behavior, evidence was **re-captured**, not reused.

## 7. Per-area evidence cheat-sheet

What to capture and manually review, by the kind of thing you changed. This is
the same taxonomy the per-package `CLAUDE.md` / `AGENTS.md` files point back to.

| If you changed… | Capture & review (beyond logs + tests) |
| --- | --- |
| **Runtime / core / agent loop** | live-LLM trajectory of provider→model→action→evaluator; memory/state rows + embeddings written; task-scheduler firing logs; `build:node` vs full `build` for shared modules |
| **A model provider plugin** | live call trajectory (request, raw response, tokens, finish reason, streamed chunks); tool-calling + structured-output parse; bad-key / model-not-found / oversized-context / rate-limit paths; latency + cost |
| **A connector plugin** | real (or sandbox) round-trip: inbound payload → agent → outbound reply, as logs **and** a recording/screenshot of the conversation; attachments/threads/edits/multi-account/error paths; the turn's trajectory |
| **A native / on-device bridge** | run on a real device/simulator (not mocked-bridge Chromium — #9967/#9580): device logs + captured output (photo/OCR/boxes/transcript/sensor); parity vs reference; permission-denied + lifecycle paths; a recording, build confirmed as yours |
| **Voice / audio** | captured audio of the STT→TTS round-trip + transcript + narrated walkthrough; latency/barge-in/wake-word on real audio across platforms (not Linux-synthetic only — #9958); failure paths (no mic, silence, noise, overlap, mid-stream drop) |
| **Wallet / chain / contracts** | tx hash(es) + explorer link, wallet balance before/after, signed-payload trail on a testnet/fork; revert/insufficient-funds/nonce/gas paths; signature-authorization checks; the initiating trajectory — never a mocked RPC |
| **UI surface** | before/after full-page screenshots (desktop+mobile, portrait+landscape, rest+hover); video walkthrough; console+network logs; empty/loading/error/permission states; per-view verdict (no `needs-work`/`broken`) |
| **Cloud backend** | real request→response against `bun run cloud:mock`; DB rows (Drizzle), billing/usage records, migration up **and** down; auth/role + multi-tenant isolation incl. denied paths (#9853/#9948); endpoint trajectory |
| **Storage / memory** | the actual rows/embeddings/documents written and read back, shape inspected; query precision/recall, ordering, pagination, migration up/down; GC/retention, concurrency, large-payload paths; recall into a real turn |
| **Benchmark / eval harness** | real-model run (not the mock fixture) → score report JSON inspected, provider/model recorded; per-item trajectories spot-reviewed; provider matrix exercised; scoring math validated; harness's own e2e against a real runtime (assert outcomes, not routing — #9970) |
| **Agent-behavior / app plugin** | live-LLM trajectory asserting the **outcome** not routing (#9970); artifacts created (memories/knowledge/scheduled tasks/relationships/documents/outputs) inspected; runner/action/service `[ClassName]` logs; empty-state + adversarial paths |
| **CLI / tooling** | real invocation transcript (args, stdout/stderr, exit code) + generated artifacts; bad-args/missing-deps/partial-state/permission/network failure paths; a recording of the run |
| **OS / device images** | exercised on real hardware/emulator: boot/setup/install logs + recording, running build confirmed; native×view matrix run on-device (Kotlin/Swift, not mocked-bridge Chromium — #9967); recovery/failure paths |
| **Docs / marketing site** | site built and changed pages rendered (before/after, desktop+mobile); link/redirect checks that resolve; embedded examples that actually run |

## 8. Why this exists

elizaOS ships autonomous-agent behavior across a runtime, a cloud, native
bridges, and dozens of plugins. Most regressions are behavioral, not type
errors — they pass CI and fail in the real loop. Recorded trajectories, real
logs, walkthrough media, and inspected domain artifacts are how we make behavior
**observable and reviewable** by a human in seconds, and how we build the corpus
that trains and evaluates the agent. Treat the evidence — and the manual review
of it — as part of the change, not paperwork after it.
