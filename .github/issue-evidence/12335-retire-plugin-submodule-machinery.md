# Issue #12335 — Retire stale plugin-submodule machinery + fix generic migrate path

Phase 3 of the #12189 script-decoupling cleanup. Removes the dead
`plugin-submodules-dev.mjs` machinery (nothing under `plugins/` is a git
submodule anymore) and repairs the broken `turbo run migrate` path that
silently no-op'd.

## What changed

1. **Deleted** `packages/scripts/plugin-submodules-dev.mjs` — the whole
   link/restore-git-submodules tool. No plugin under `plugins/` is a submodule,
   so it operated on nothing.
2. **Removed** the root `package.json` `"plugin-submodules:restore"` script
   (only caller of the deleted tool).
3. **`packages/scripts/dev-harness.mjs`**:
   - Removed the `run("bun", ["packages/scripts/plugin-submodules-dev.mjs"])`
     shell-out and its `[dev] plugin submodules…` log line.
   - Removed the nonexistent `plugins/plugin-local-ai` entry from
     `PLUGIN_TYPESCRIPT` (kept `plugin-sql`, `plugin-ollama`).
   - Updated the header comment (dropped the "plugin submodules" opener and the
     `plugin-submodules:restore` reference).
4. **`packages/scripts/audit-scripts.mjs`**: removed `"plugin-submodules"` from
   the `ALLOWED_NAMESPACES` allowlist. No new false positive results (the only
   script in that namespace, `plugin-submodules:restore`, was removed in step 2).
5. **`plugins/plugin-sql/package.json`**: added `migrate` / `migrate:generate`
   scripts that delegate into `src/`, mirroring the existing
   `"build": "cd src && ..."` pattern. The commands (`drizzle-kit migrate` /
   `drizzle-kit generate`) are copied verbatim from the nested
   `plugins/plugin-sql/src/package.json`. Before this, the root `migrate` turbo
   task filtered to `./plugins/plugin-sql` resolved to command `<NONEXISTENT>`
   and silently did nothing because the workspace package had no such script.
6. **`.gitmodules`** llama.cpp comment: re-checked, already accurate — left
   untouched.

## Verification (real output)

### No `plugin-submodules` references remain
```
$ grep -rn "plugin-submodules" --include="*.mjs" --include="*.json" . | grep -v node_modules | grep -v issue-evidence
$ echo exit: $?
exit: 1        # no matches
```

### No `plugin-local-ai` in dev-harness
```
$ grep -rn "plugin-local-ai" packages/scripts/dev-harness.mjs
$ echo exit: $?
exit: 1        # no matches
```

### migrate turbo task now resolves a real command (was `<NONEXISTENT>`)
```
$ node packages/scripts/run-turbo.mjs run migrate --filter=./plugins/plugin-sql --dry=json 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const t=(j.tasks||[]).find(t=>t.taskId&&t.taskId.includes('plugin-sql')&&t.taskId.includes('migrate'));console.log('resolved command:', t&&t.command)})"
resolved command: cd src && drizzle-kit migrate
```

### audit:scripts — no new finding from this change
`origin/develop` (pristine) and this branch both emit the identical single
pre-existing finding (`audit:error-policy-ratchet:self-test` orphan, unrelated to
this issue). Removing `plugin-submodules` from the namespace allowlist introduced
no new false positive.

```
# pristine origin/develop:
[audit-scripts] 1 finding(s):
  - [orphan] root script "audit:error-policy-ratchet:self-test" is never referenced ...

# this branch (identical):
[audit-scripts] 1 finding(s):
  - [orphan] root script "audit:error-policy-ratchet:self-test" is never referenced ...
```

### lint on changed scripts
```
$ bunx @biomejs/biome lint packages/scripts/dev-harness.mjs packages/scripts/audit-scripts.mjs
Checked 2 files in 23ms. No fixes applied.
```

### package.json integrity
```
$ node -e "const p=require('./plugins/plugin-sql/package.json'); console.log('migrate:', p.scripts.migrate, '| migrate:generate:', p.scripts['migrate:generate'])"
migrate: cd src && drizzle-kit migrate | migrate:generate: cd src && drizzle-kit generate
$ node -e "const p=require('./package.json'); console.log('plugin-submodules:restore present?', 'plugin-submodules:restore' in p.scripts)"
plugin-submodules:restore present? false
```
