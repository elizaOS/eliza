# issue-evidence

Human-verifiable proof attached to issues and PRs. A reviewer should be able to
open these files and confirm a change works **without reading the code**. The
full shipping standard is `PR_EVIDENCE.md` (repo root).

## What goes here

Real artifacts that demonstrate the fix/feature actually happening:

- **Screenshots** — before/after, full-page (`.png`).
- **Video walkthroughs** — full click-through of a flow (`.mp4`/`.webm`; if too
  large for git, upload elsewhere and keep a representative still here plus the
  link in the PR).
- **Audio** — captured voice/TTS/STT round-trips and narrated walkthroughs.
- **Real-LLM trajectories** — scenario-runner JSON reports / run viewers /
  native jsonl from a live model (not the deterministic proxy).
- **Logs** — backend (`[ClassName] …`) and frontend (console/network) excerpts
  that show the actual code path.

## Naming

```
<issue#>-<short-kebab-slug>.<ext>
```

Examples (already in this directory):

```
8810-cloud-handoff-banner-states.png
8812-boot-kpi-rebaseline.png
```

- One `<issue#>` prefix per issue; add a numeric/letter suffix when an issue has
  several artifacts (`8810-...-1.png`, `8810-...-after.mp4`).
- Keep slugs descriptive — the filename alone should say what it proves.

## How it's produced

```bash
# Real-LLM agent trajectories
packages/scenario-runner/bin/eliza-scenarios run <scenario.ts> --report <out.json>

# E2E UI recordings (video + contact sheets + viewer)
bun run test:e2e:record

# App + cloud-UI per-route screenshots (REQUIRED for UI changes)
bun run --cwd packages/app audit:app

# Native per-platform capture (screenshot + recording + logs → this dir).
# Skip-with-reason (exit 0) when no simulator/emulator is present:
bun run --cwd packages/app capture:ios-sim -- --issue <n> --slug <s>
bun run --cwd packages/app capture:android-emu -- --issue <n> --slug <s>
```

See the per-platform capture matrix in `PR_EVIDENCE.md` for the full
surface→command mapping.

Reference the file(s) from the PR body so the proof travels with the change.
