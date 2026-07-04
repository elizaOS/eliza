# Evidence: #12262 move voice root wrappers to app-core

Date: 2026-07-04

## Change

- Deleted root `voice:latency-report`, `voice:interactive`, `voice:duet`, and `voice:create-profile`.
- Added missing `packages/app-core` package scripts for `voice:latency-report` and `voice:create-profile`.
- Kept existing app-core `voice:interactive` and `voice:duet` package scripts as the canonical entrypoints.
- Updated root migration docs and root-style command examples to use `bun run --cwd packages/app-core ...`.

Screenshots/recordings: N/A. This is a CLI/script-surface cleanup with no UI behavior change.

## Verification

```bash
node <<'NODE'
const root=require('./package.json').scripts;
for (const n of ['voice:latency-report','voice:interactive','voice:duet','voice:create-profile']) if (Object.hasOwn(root,n)) throw new Error(`${n} still root`);
if (Object.keys(root).length !== 199) throw new Error(`root count ${Object.keys(root).length}`);
const app=require('./packages/app-core/package.json').scripts;
for (const n of ['voice:latency-report','voice:interactive','voice:duet','voice:create-profile']) if (!app[n]) throw new Error(`missing app-core ${n}`);
console.log('voice wrapper migration assertions passed');
NODE
# voice wrapper migration assertions passed
```

```bash
node scripts/assert-agents-claude-identical.mjs
# [assert-agents-claude-identical] PASS: 301 tracked CLAUDE.md/AGENTS.md pair(s) are byte-identical.
```

```bash
node packages/scripts/audit-scripts.mjs
# [audit-scripts] OK - no orphan/no-op/broken scripts.
```

```bash
grep -RIn "bun run voice:latency-report\|bun run voice:interactive\|bun run voice:duet\|bun run voice:create-profile" docs packages plugins scripts CLAUDE.md AGENTS.md package.json
# Remaining hits are root migration docs only.
```

```bash
bun run --cwd packages/app-core voice:interactive -- --list-active
# exits 0 and prints the active optimization/prerequisite report.
```

```bash
bun run --cwd packages/app-core voice:create-profile -- --help
# exits 0 and prints usage.
```

```bash
bun run --cwd packages/app-core voice:latency-report -- --help
# exits 0 and prints usage.
```

```bash
bun run --cwd packages/app-core voice:duet -- --list-active
# runs the prereq report and exits 1 because this machine is missing the local eliza-1-2b bundle, real TTS backend, ASR backend, and Silero VAD model.
```

```bash
git diff --check
# no output
```
