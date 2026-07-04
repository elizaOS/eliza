# #12903 runnable TypeScript examples script-contract evidence

Branch slice: normalize script contracts for five runnable TypeScript examples.

## Packages

- `packages/examples/autonomous`
- `packages/examples/chat`
- `packages/examples/convex`
- `packages/examples/mcp`
- `packages/examples/telegram`

## Script contract changes

- Removed `build: bun run typecheck`; these packages do not emit build
  artifacts.
- Kept `typecheck` as the real TypeScript validation command.
- Added read-only `lint:check`.
- Added `format` and read-only `format:check`.

## Verification

Current working tree: `github/develop` at `02928af63c`.

Static guard:

```bash
node - <<'NODE'
const fs = require('fs');
const files = ['packages/examples/autonomous/package.json','packages/examples/chat/package.json','packages/examples/convex/package.json','packages/examples/mcp/package.json','packages/examples/telegram/package.json'];
for (const p of files) {
  const pkg = JSON.parse(fs.readFileSync(p,'utf8'));
  const scripts = pkg.scripts || {};
  const bad = [];
  if ('build' in scripts) bad.push(`build=${scripts.build}`);
  if (!scripts.typecheck) bad.push('missing typecheck');
  for (const name of ['lint:check','format','format:check']) if (!scripts[name]) bad.push(`missing ${name}`);
  if (bad.length) { console.error(`${p}: ${bad.join('; ')}`); process.exitCode = 1; }
  else console.log(`${p}: fake build removed; check verbs present`);
}
NODE
```

Result:

```text
packages/examples/autonomous/package.json: fake build removed; check verbs present
packages/examples/chat/package.json: fake build removed; check verbs present
packages/examples/convex/package.json: fake build removed; check verbs present
packages/examples/mcp/package.json: fake build removed; check verbs present
packages/examples/telegram/package.json: fake build removed; check verbs present
```

Read-only lint and format:

```bash
for pkg in packages/examples/autonomous packages/examples/chat packages/examples/convex packages/examples/mcp packages/examples/telegram; do
  bun run --cwd "$pkg" lint:check
  bun run --cwd "$pkg" format:check
done
```

Result:

```text
packages/examples/autonomous: biome check passed for 6 files; biome format passed for 6 files.
packages/examples/chat: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/convex: biome check passed for 11 files; biome format passed for 11 files.
packages/examples/mcp: biome check passed for 4 files; biome format passed for 4 files.
packages/examples/telegram: biome check passed for 5 files; biome format passed for 5 files.
```

Typecheck:

```bash
bun run --cwd plugins/plugin-inmemorydb build
bun run --cwd plugins/plugin-google-genai build
for pkg in packages/examples/autonomous packages/examples/chat packages/examples/convex packages/examples/mcp packages/examples/telegram; do
  bun run --cwd "$pkg" typecheck
done
```

Result:

```text
packages/examples/autonomous: passed after building @elizaos/plugin-inmemorydb
packages/examples/chat: passed
packages/examples/convex: passed after building @elizaos/plugin-google-genai
packages/examples/mcp: passed
packages/examples/telegram: passed
```

Tests:

```bash
for pkg in packages/examples/autonomous packages/examples/chat packages/examples/convex packages/examples/mcp packages/examples/telegram; do
  timeout 60s bun run --cwd "$pkg" test
done
```

Result:

```text
packages/examples/autonomous: 4 tests passed
packages/examples/chat: 3 tests passed
packages/examples/convex: skipped cleanly because CONVEX_URL is not set
packages/examples/mcp: stdio smoke passed; live chat skipped unless ELIZA_EXAMPLE_MCP_LIVE_CHAT=1
packages/examples/telegram: 2 tests passed
```

This slice changes only package scripts; it does not change runtime or test code.
