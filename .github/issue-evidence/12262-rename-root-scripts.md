# Evidence: #12262 rename root scripts

Date: 2026-07-04

## Change

- Renamed `test:ci:live` to `test:live`.
- Renamed the `test:lint*` integrity family to `audit:test-integrity*`.
- Renamed `verify:smartglasses-software` to `audit:smartglasses-software`.
- Renamed personality benchmark scripts to `bench:personality` and `bench:personality:calibrate`.
- Updated root migration docs and package/docs references.
- Fixed the personality calibrate root body to call the package directly with `--cwd`.

Screenshots/recordings: N/A. This is a CLI/script/docs cleanup with no UI behavior change.

## Verification

```bash
node <<'NODE'
const p=require('./package.json').scripts;
const oldNames=['test:ci:live','test:lint','test:lint:no-vi-mocks','test:lint:lane-coverage','test:lint:test-integrity','test:lint:test-integrity:self-test','verify:smartglasses-software','personality:judge','personality:bench:calibrate'];
for (const n of oldNames) if (Object.hasOwn(p,n)) throw new Error(`${n} still exists`);
const newNames=['test:live','audit:test-integrity:all','audit:test-integrity:no-vi-mocks','audit:test-integrity:lane-coverage','audit:test-integrity','audit:test-integrity:self-test','audit:smartglasses-software','bench:personality','bench:personality:calibrate'];
for (const n of newNames) if (!Object.hasOwn(p,n)) throw new Error(`${n} missing`);
if (Object.keys(p).length !== 188) throw new Error(`count ${Object.keys(p).length}`);
console.log('root rename assertions passed');
NODE
# root rename assertions passed
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
grep -RIn "test:ci:live\|test:lint\|verify:smartglasses-software\|personality:judge\|personality:bench:calibrate" docs packages plugins scripts CLAUDE.md AGENTS.md package.json
# Remaining hits are root migration docs only.
```

```bash
bun run audit:test-integrity:self-test
# [lint-test-integrity.self-test] PASS 38 assertions
```

```bash
PERSONALITY_JUDGE_ENABLE_LLM=0 bun run bench:personality -- --calibration --output /tmp/eliza-personality-calib.md --output-json /tmp/eliza-personality-calib.json
# wrote /tmp/eliza-personality-calib.md (957 scenarios) - pass=429 fail=506 review=22
```

```bash
bun run bench:personality:calibrate -- --help
# exits 0 and prints Vitest help via packages/benchmarks/personality-bench calibrate.
```

Expected existing gate failures:

```bash
bun run audit:test-integrity:no-vi-mocks
# invokes the renamed command and fails on existing forbidden vi.fn/vi.mock inventory.

bun run audit:test-integrity:lane-coverage
# invokes the renamed command and fails on existing plugin lane coverage inventory.
```

```bash
node --check scripts/verify-smartglasses-software.mjs
node --check packages/scripts/run-all-tests.mjs
```

```bash
git diff --check
# no output
```
