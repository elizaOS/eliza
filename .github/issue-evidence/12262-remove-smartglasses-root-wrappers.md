# Evidence: #12262 remove smartglasses root wrappers

Date: 2026-07-04

## Change

- Deleted 11 root `smartglasses:*` package-wrapper scripts.
- Documented direct `bun run --cwd packages/examples/smartglasses ...` replacements in root `CLAUDE.md` / `AGENTS.md`.
- Updated smartglasses docs, user-facing hardware guidance strings, and affected tests to point at package-local commands.
- Removed `smartglasses` from the root script audit namespace allowlist.
- Updated `scripts/check-smartglasses-completion-gate.mjs` so it validates package-local smartglasses scripts rather than root aliases.

Screenshots/recordings: N/A. This is a CLI/script/docs cleanup with no UI behavior change.

## Verification

```bash
node --check scripts/check-smartglasses-completion-gate.mjs
```

```bash
node -e "const p=require('./package.json').scripts; const names=['smartglasses:hardware:doctor','smartglasses:hardware:status','smartglasses:hardware:validate','smartglasses:hardware:prove','smartglasses:hardware:prove:watch','smartglasses:hardware:prove:noble','smartglasses:hardware:prove:noble:watch','smartglasses:dev:hardware','smartglasses:dev:simulator','smartglasses:simulator','smartglasses:smoke:simulator']; for (const n of names) if (Object.hasOwn(p,n)) throw new Error(n); if (Object.keys(p).length !== 188) throw new Error('count '+Object.keys(p).length); console.log('smartglasses wrapper deletion assertions passed')"
# smartglasses wrapper deletion assertions passed
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
grep -RIn "npm run smartglasses:\|smartglasses:hardware:\|smartglasses:dev:\|smartglasses:simulator\|smartglasses:smoke:simulator" packages/examples/smartglasses plugins/plugin-facewear/docs scripts/check-smartglasses-completion-gate.mjs package.json
# no output
```

```bash
bun run --cwd packages/examples/smartglasses hardware:test-doctor
# node --check hardware-doctor.mjs
# exited 0
```

```bash
bun run --cwd packages/examples/smartglasses hardware:status-latest
# exited nonzero only when no report is present; printed structured missingReport JSON with the new package-local nextAction command.
```

Known local limitations:

```bash
node scripts/check-smartglasses-completion-gate.mjs --self-test
# exits 1 on this checkout with pre-existing software-contract failures unrelated to root alias deletion:
# - packages/examples/smartglasses/package.json typecheck hardware-local-bluetooth check
# - plugins/plugin-facewear build/register/app-registration checks
```

```bash
bun run --cwd packages/examples/smartglasses test
# fails in this auxiliary worktree resolving @elizaos/plugin-facewear and @elizaos/plugin-facewear/protocol/smartglasses.
# The shared dependency install uses broken relative workspace symlinks for this worktree; CI with a fresh install should resolve them.
```

```bash
git diff --check
# no output
```
