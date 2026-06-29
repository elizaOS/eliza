# Definition of Done — sync, PR, and human-verifiable evidence

This is the repo-wide standard for shipping work in the elizaOS monorepo. It
applies to **every** fix, feature, refactor, and doc change, in every package
and plugin. The bar is simple to state:

> A reviewer must be able to confirm the change works **without reading the
> code** — by watching it happen and inspecting the artifacts you attached.

If a human can't verify it from the evidence, it isn't done.

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
| **Real LLM-call trajectory** | agent behavior, actions, providers, prompts, models | `scenario-runner` against a **live** LLM (not the deterministic proxy) — JSON report + run viewer + native jsonl | scenario report path + `.github/issue-evidence/` |
| **Backend logs** | runtime, API, services, schedulers | structured logger output (`[ClassName] …`) showing the code path firing end to end | paste in PR + file in `.github/issue-evidence/` |
| **Frontend logs** | any UI / client | browser console + network trace showing the request/response and state change | paste in PR + screenshot |
| **Full-page screenshots** | any UI change | `audit:cloud` (cloud-frontend) or `test:e2e:record` sheets; before **and** after | `.github/issue-evidence/` |
| **Video walkthrough** | any user-facing flow | `bun run test:e2e:record` (records the run) — a full click-through of the feature | `.github/issue-evidence/` (link if large) |
| **Audio/voice walkthrough** | voice, transcript, TTS/STT, omnivoice | captured audio of the real round-trip + a narrated walkthrough of what's happening | `.github/issue-evidence/` (link if large) |

The point of all six is the same: **prove the real thing happened.** Real model
calls, real log lines, real pixels, real audio — not a description of what
should happen, not a unit test asserting a mock.

### Per-platform capture matrix — screenshot + recording + logs are DEFAULT-REQUIRED

The **Full-page screenshots** and **Video walkthrough** rows above are not a
single web flow — they apply to **whichever platform surface your change runs
on**. For every surface your change touches, attach a screenshot **and** a
screen recording **and** the platform logs, produced by the one command named
here. These three are **default-required** per touched platform; marking a
platform **N/A** requires a written reason in the PR (e.g. "change is iOS-only,
Android untouched").

| Surface the change touches | One command → screenshot + recording + logs | Artifacts land in |
| --- | --- | --- |
| **web** (browser dashboard / marketing) | `bun run test:e2e:record` | `e2e-recordings/` + `.github/issue-evidence/` |
| **cloud-frontend** (hosted dashboard) | `bun run --cwd packages/cloud-frontend audit:cloud` (or `bun run --cwd packages/app audit:app` for the app shell) | `aesthetic-audit-output/` |
| **desktop (electrobun)** | `bun run capture:linux` / `bun run capture:windows` grabs the host desktop incl. the Electrobun window. _A window-scoped Electrobun capture is TODO: tooling tracked in #9944._ | `.github/issue-evidence/<issue>-<slug>/<platform>/` |
| **ios-sim** | `bun run capture:ios-sim` | `.github/issue-evidence/<issue>-<slug>/ios/` |
| **android-emu / device** | `bun run capture:android` | `.github/issue-evidence/<issue>-<slug>/android/` |
| **linux-desktop** | `bun run capture:linux` | `.github/issue-evidence/<issue>-<slug>/linux/` |
| **windows-desktop** | `bun run capture:windows` | `.github/issue-evidence/<issue>-<slug>/windows/` |

Each `capture:*` helper writes `screen.png` + `screen.{mp4,mov}` + a log tail
(`logcat.log` / `simctl.log` / `desktop.log`) and **skips with a reason** (clean
exit) when its platform, tooling (adb / xcrun / ffmpeg), or device/simulator is
absent — so a deviceless CI run is a clean no-op, but a real run on the target
platform produces real artifacts. Run all available platforms at once with
`bun run capture:all` (or fold them into `test:e2e:record` via `--capture` /
`E2E_CAPTURE=1`). Override the issue/slug/duration with
`--issue=<n> --slug=<s> --seconds=<n>` (defaults: `9944` / `evidence-capture` /
`7`).

### The tools that produce this evidence (all already in the repo)

```bash
# Real-LLM agent trajectories (boots a real AgentRuntime + live LLM, emits a
# JSON report + a self-contained run viewer + training-corpus jsonl):
packages/scenario-runner/bin/eliza-scenarios run <scenario.ts> --report <out.json>
#   src: packages/scenario-runner — see its CLAUDE.md. Use a live model, not the
#   deterministic proxy, when the trajectory IS the evidence.

# End-to-end UI recordings (video + contact sheets + a browsable viewer):
bun run test:e2e:record                  # scripts/e2e-recordings/run-all.mjs
bun run test:e2e:record:sheets           # regenerate contact sheets + viewer
bun run test:e2e:audit-ui                # coverage of which routes are recorded

# Cloud-frontend per-route screenshots (desktop + mobile, rest + hover), with a
# manual-review verdict stub per page — REQUIRED for cloud-frontend UI changes:
bun run --cwd packages/cloud-frontend audit:cloud

# Per-platform native capture (screenshot + recording + logs) — issue #9944.
# Each helper auto-detects its platform/tooling and skips with a reason when
# absent (so CI without a device is a clean no-op):
bun run capture:android   # adb screencap + screenrecord + logcat (device/emulator)
bun run capture:ios-sim   # xcrun simctl screenshot + recordVideo + log (booted sim, macOS)
bun run capture:linux     # ffmpeg x11grab screenshot + recording + info log
bun run capture:windows   # ffmpeg gdigrab screenshot + recording + info log
bun run capture:all       # run every available platform capture, skipping the rest
#   src: scripts/e2e-recordings/capture/*.mjs — artifacts land in
#   .github/issue-evidence/<issue>-<slug>/<platform>/
```

### Where artifacts live

- Issue/PR-scoped artifacts: **`.github/issue-evidence/<issue#>-<slug>.<ext>`**
  (e.g. `8810-cloud-handoff-banner-states.png`). One prefix per issue; see that
  directory's `README.md`.
- Scenario reports + run viewers: the `--report` path you pass; reference it in
  the PR and copy the viewer/JSON into `.github/issue-evidence/` if it's the
  proof.
- E2E recordings/sheets: under the recordings dir produced by
  `test:e2e:record`; link or embed the relevant frames.
- Cloud-frontend audit: `packages/cloud-frontend/aesthetic-audit-output/`
  (fill `manual-review/<slug>.md` per page — no page may stay `needs-work` /
  `broken`).

Large media (video/audio) that doesn't belong in git: upload it and put the
link in the PR body, but keep a representative still/clip in `issue-evidence/`
so the proof survives even if the link rots.

## 4. Completeness & carefulness gate (before you mark a PR ready)

- [ ] Branch rebased/merged onto the **latest** `origin/develop`; **zero conflicts**.
- [ ] `bun run verify` (typecheck + lint) passes.
- [ ] Relevant tests pass (`bun run test`, or the scoped `--cwd <pkg> test`).
- [ ] For agent/LLM behavior: a **real-LLM** trajectory is attached and matches the claim.
- [ ] Backend and/or frontend logs attached, showing the actual code path.
- [ ] For UI: before/after full-page screenshots + a video walkthrough, captured on **every platform the change runs on** via the per-platform capture matrix above (screenshot + recording + logs each; `N/A` carries a written reason).
- [ ] For voice/audio: captured audio of the real round-trip + a narrated walkthrough.
- [ ] Every evidence row above is either attached **or** explicitly marked N/A with a reason.
- [ ] The PR description tells a reviewer exactly what to watch/read to confirm it — no code-reading required.
- [ ] If `develop` moved and changed behavior, evidence was **re-captured**, not reused.

## 5. Why this exists

elizaOS ships autonomous-agent behavior across a runtime, a cloud, native
bridges, and dozens of plugins. Most regressions are behavioral, not type
errors — they pass CI and fail in the real loop. Recorded trajectories, real
logs, and walkthrough media are how we make behavior **observable and
reviewable** by a human in seconds, and how we build the corpus that trains and
evaluates the agent. Treat the evidence as part of the change, not paperwork
after it.
