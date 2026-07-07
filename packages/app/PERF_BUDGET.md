# Mobile cold-boot TTI + build-time budget

The measurement contract for iOS/Android **cold boot** and **build/rebuild**
speed (issue #14414). The goal: land the user in a usable chat shell as fast as
possible while the local agent boots behind it, and keep the inner rebuild loop
tight. This doc is the instrument — `perf-budgets.json` holds the numbers and
`scripts/check-startup-budget.mjs` is the regression gate.

## What is measured

| Metric | Source artifact | Mark / value |
| --- | --- | --- |
| `tti/ci-web` | `scripts/capture-startup-trace.mjs` (headless Chromium) | `startup-shell:mounted` atMs — usable-shell paint |
| `tti/android-lowram` | same trace, `--url` a device-tunnelled WebView | `startup-shell:mounted` |
| `tti/ios-reference` | same trace against the iOS sim WebView | `startup-shell:mounted` |
| `build/android-apk` | `run-mobile-build.mjs` timing json | wall-clock `buildMs` |
| `build/ios-ipa` | same | wall-clock `buildMs` |
| `build/rebuild-loop` | renderer-only change → device visible | wall-clock |

TTI is measured to `startup-shell:mounted` — the unconditional shell-mount
checkpoint (`packages/ui/.../StartupShell.tsx`), i.e. the moment the user lands
in a usable shell. `startup-shell:first-paint` is splash-delay-gated and absent
on boots faster than the gate, so it is only a fallback; `coordinator:ready`
(agent fully booted) is the last fallback and a separate, looser target.

## Capture + gate

```bash
# 1. TTI on the CI-runnable web path (no device, no model key)
bun run --cwd packages/app dev &                    # or point --url at a device WebView
bun run --cwd packages/app trace:startup -- --out /tmp/trace.json

# 2. Build time (opt-in emit; default builds are unchanged)
ELIZA_MOBILE_BUILD_TIMING_OUT=/tmp/build-timing.json bun run build:android

# 3. Gate: fail on over-budget OR a >tolerance regression past the baseline
bun run --cwd packages/app perf:startup-budget -- \
  --trace /tmp/trace.json --tti-target ci-web \
  --build-timing /tmp/build-timing.json --build-target android-apk \
  --out /tmp/budget-report.json
```

The gate exits non-zero when any metric is over its hard `budgetMs` ceiling or
regresses past `baselineMs` by more than `tolerancePct` (default 15%). A metric
with no measurement is a **failure**, not a silent pass — an unmeasured budget
must never read as green.

### Recording baselines

Run the capture on the reference target, then:

```bash
bun run --cwd packages/app perf:startup-budget -- \
  --trace /tmp/trace.json --tti-target ios-reference --update-baseline
```

`--update-baseline` rewrites the matched `baselineMs` in `perf-budgets.json` and
exits 0 on that recording run. Commit the updated baselines with the PR that
moved them. Reference-device (`android-lowram`, `ios-reference`) and build
baselines are recorded on those targets in CI, not from a laptop.

## Fastest inner loop for renderer-only changes

A renderer-only change does **not** need a full native rebuild:

- **Dev / iteration:** `bun run --cwd packages/app dev` serves the web bundle
  with Vite HMR; point the installed app's WebView at the dev URL (VPS →
  Cloudflare-tunnel → installed PWA loop, #14383/#14398) so a renderer edit is
  visible in seconds. Do **not** re-bake + reinstall the APK/IPA per edit.
- **Release only:** `build:ios` / `build:android` bake the web bundle into the
  APK/IPA (turbo caches the `build` web step). Reserve the full native rebuild
  for release artifacts and native-code changes.

Baking the web bundle into the binary at build time is why a Capacitor app must
be rebuilt + reinstalled to pick up a renderer change (see `AGENTS.md`); the dev
loop above sidesteps that for iteration.
