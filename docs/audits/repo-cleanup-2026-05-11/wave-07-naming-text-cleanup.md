# Wave 07 - Naming And Text Cleanup Dry Run

Status: dry run only. No source files were changed.

## Scope

This wave targets AI slop and transitional naming in live source, tests, generated docs, and audit docs:

- Comments that describe implementation history instead of current behavior.
- Names containing `slop`, `larp`, `legacy`, `deprecated`, `fallback`, `shim`, `stub`, `unified`, `consolidated`, or `cleanup`.
- Markdown and generated prompt text that leaks internal migration language into long-term docs.
- API or file names that should be canonical now that the transitional path has landed.

This wave must not globally remove these words. Some are domain-valid: fallback routes, browser shims, OpenZeppelin fallback handlers, cleanup jobs, migration code, and vault "unified login" semantics can be legitimate.

## Initial Scan Summary

Read-only commands used:

```bash
rg --files packages plugins cloud scripts test docs | rg -i '/[^/]*(slop|larp|legacy|deprecated|fallback|shim|stub|unified|consolidated|cleanup)[^/]*$' | wc -l
rg -n -i --glob '!packages/agent/dist-mobile/**' --glob '!packages/inference/llama.cpp/**' --glob '!packages/benchmarks/OSWorld/**' --glob '!reports/**' '\b(slop|flavor text|larp|TODO|FIXME|HACK|XXX)\b' packages plugins cloud scripts test docs | wc -l
rg -n '\b[A-Za-z0-9_]*(Legacy|Deprecated|Fallback|Shim|Stub|Unified|Consolidated|Cleanup|Slop|Larp)[A-Za-z0-9_]*\b' packages plugins cloud scripts test docs | wc -l
```

Results at scan time:

- 143 filename matches across source/docs/test surfaces.
- 1,946 TODO/FIXME/HACK/LARP/slop text matches after excluding large generated/vendor paths.
- 4,593 identifier/comment matches for the broader transitional-name pattern.

These counts are too broad to treat as a deletion list. The implementation pass should generate a machine-readable candidate table before edits:

```bash
mkdir -p docs/audits/repo-cleanup-2026-05-11/generated
rg --json -n -i --glob '!packages/agent/dist-mobile/**' --glob '!packages/inference/llama.cpp/**' --glob '!packages/benchmarks/OSWorld/**' --glob '!reports/**' '\b(slop|flavor text|larp|TODO|FIXME|HACK|XXX)\b' packages plugins cloud scripts test docs > docs/audits/repo-cleanup-2026-05-11/generated/wave-07-text-candidates.json
rg --json -n '\b[A-Za-z0-9_]*(Legacy|Deprecated|Fallback|Shim|Stub|Unified|Consolidated|Cleanup|Slop|Larp)[A-Za-z0-9_]*\b' packages plugins cloud scripts test docs > docs/audits/repo-cleanup-2026-05-11/generated/wave-07-name-candidates.json
```

## Safe Proposed Changes

### Rename runtime slop test files

Candidate files:

- `packages/elizaos/templates/min-project/tests/runtime-slop.test.ts`
- `packages/elizaos/templates/min-plugin/tests/runtime-slop.test.ts`

Observed contents already use `describe("runtime scaffold", ...)`. The file names are the only slop marker.

Proposed change:

- Rename both files to `runtime-scaffold.test.ts`.
- Update any references in template docs or scaffolding snapshots if found.

Validation:

```bash
git grep -n 'runtime-slop'
/Users/shawwalters/.bun/bin/bun run --cwd packages/elizaos test
/Users/shawwalters/.bun/bin/bun run typecheck
```

Risk: low.

### Replace `larp` wording in implementation comments

Candidate comments:

- `packages/app-core/src/services/local-inference/engine.ts:435-444`
- `packages/agent/src/runtime/prompt-compaction.ts:109-110`

Proposed text:

- Replace `"claims-128k-but-actually-8k" larp` with `"claims-128k-but-runs-8k" bug`.
- Replace `style larping` with `unsupported execution claims`.

Validation:

```bash
/Users/shawwalters/.bun/bin/bun run --cwd packages/app-core typecheck
/Users/shawwalters/.bun/bin/bun run --cwd packages/agent typecheck
```

Risk: low.

### Convert Wave TODO comments into neutral integration notes

Candidate files:

- `plugins/app-lifeops/src/actions/inbox-unified.ts`
- `plugins/app-lifeops/src/actions/brief.ts`
- `plugins/app-lifeops/src/actions/document.ts`
- `plugins/app-lifeops/src/actions/conflict-detect.ts`
- `plugins/app-lifeops/src/actions/prioritize.ts`

These are not safe to delete. They are real integration seams. The cleanup should replace historical `TODO Wave-2` language with neutral current-state notes such as `Pending integration:` and link to the owning task or issue once one exists.

Validation:

```bash
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify
rg -n 'TODO Wave-|Wave-[0-9]|W[0-9]-[A-Z]' plugins/app-lifeops/src plugins/plugin-health/src
```

Risk: medium. Some comments document behavior that tests currently rely on.

## Medium-Risk Candidate Changes

### Remove unused contact resolver shim if still unreferenced

Candidate:

- `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts`

Read-only grep found only self-references:

```bash
git grep -n 'createContactResolverShim\|ContactResolverShim\|ResolvedContactShim' -- plugins packages test docs
```

Proposed implementation path:

1. Confirm no imports after generated files are cleaned.
2. Confirm no package export barrel exposes the file.
3. Delete the file only after `plugins/app-lifeops` typecheck passes.

Validation:

```bash
git grep -n 'resolver-shim'
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify
/Users/shawwalters/.bun/bin/bun run typecheck
```

Risk: medium because AGENTS.md explicitly protects entity/relationship behavior.

### Replace `contract-stubs` naming only after contracts are real

Candidate files:

- `plugins/app-lifeops/src/default-packs/contract-stubs.ts`
- `plugins/plugin-health/src/default-packs/contract-stubs.ts`
- `plugins/plugin-health/src/connectors/contract-stubs.ts`

Current imports are broad and active, including default packs, tests, and plugin-health connectors. A naming-only change would create churn without fixing behavior. This belongs after Wave 2 creates canonical shared contract modules.

Proposed end state:

- App LifeOps default-pack contracts import from a canonical default-pack contract module.
- plugin-health default-pack contracts import from the same public contract, without importing LifeOps internals.
- plugin-health connector contracts import from the canonical connector/channel contract.
- Remove `contract-stubs` filenames only after all imports have moved.

Validation:

```bash
git grep -n 'contract-stubs' -- plugins/app-lifeops plugins/plugin-health packages test
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify
/Users/shawwalters/.bun/bin/bun run typecheck
```

Risk: high if done before Wave 2.

### Rename `inbox-unified` only after action API decision

Candidate:

- `plugins/app-lifeops/src/actions/inbox-unified.ts`

This file exports public action symbols including `InboxUnified*`, `setInboxUnifiedFetchers`, and `inboxUnifiedAction`. It is registered by `plugins/app-lifeops/src/plugin.ts`.

Possible canonical names:

- `inbox.ts` if this is the only inbox action.
- `owner-inbox.ts` if matching action umbrella naming.
- Keep current name if generated action docs or prompts expose `INBOX_UNIFIED` as public compatibility.

Validation:

```bash
git grep -n 'inboxUnified\|InboxUnified\|INBOX_UNIFIED\|inbox-unified'
/Users/shawwalters/.bun/bin/bun run --cwd plugins/app-lifeops verify
```

Risk: high because action names may be part of generated prompt specs.

## Do-Not-Auto-Rename Terms

Keep until an owner decides otherwise:

- `fallback` in route fallback modules, provider fallback tests, wallet/browser fallback behavior, and native fallback handlers.
- `shim` in browser-wallet shims, test aliases, native AOSP/seccomp shims, and compatibility adapters.
- `legacy` in actual migrations, database migration names, OpenZeppelin test fixtures, and explicit compatibility layers.
- `cleanup` in cron cleanup jobs, runtime cleanup functions, and resource cleanup callbacks.
- `unified` in vault unified login results unless product renames the concept.
- `consolidated` in audit/changelog prose unless the docs wave chooses to archive that prose.

## Docs And Generated Prompt Candidates

Candidate docs to fold into Wave 6/7 docs cleanup:

- `docs/audits/lifeops-2026-05-09/02-scenario-larp-audit.md`
- `docs/audits/lifeops-2026-05-09/09-doc-and-larp-cleanup.md`
- `docs/audits/lifeops-2026-05-11/larp-purge.md`
- `plugins/app-lifeops/docs/audit/HARDCODING_AUDIT.md`
- `plugins/app-lifeops/docs/audit/GAP_ASSESSMENT.md`
- `plugins/app-lifeops/docs/audit/IMPLEMENTATION_PLAN.md`
- `plugins/app-lifeops/docs/audit/JOURNEY_GAME_THROUGH.md`

Proposed rule:

- Keep one current architecture source and one historical archive index.
- Delete or archive superseded wave narrative docs only after Wave 6 sets the markdown retention policy.
- Do not edit generated prompt-manifest files by hand. Regenerate them after source action descriptions change.

## Proposed Guardrail

Add a source-only lint after the cleanup is complete:

```bash
rg -n -i --glob 'packages/**/src/**' --glob 'plugins/**/src/**' --glob 'cloud/**/src/**' '\b(AI slop|LARP|flavor text|TODO Wave-|Wave-[0-9]|W[0-9]-[A-Z]|FIXME|HACK|XXX)\b'
```

The lint should fail only for the high-signal terms above. It should not fail on `fallback`, `shim`, `stub`, `legacy`, `unified`, or `cleanup` without an allowlist because those are often real domain terms.

## Implementation Checklist

- Generate candidate JSON reports.
- Approve the safe rename/comment edits.
- Land Wave 2 contract canonicalization before touching `contract-stubs` names.
- Land Wave 3 route ownership before touching fallback route names.
- Land Wave 6 docs policy before deleting audit docs.
- Rename low-risk files and update references.
- Remove unused shims only after grep, Knip, package export checks, and typecheck.
- Regenerate generated action docs/prompt specs after source text changes.
- Run LifeOps verify, root typecheck, Knip targeted checks, and source-only slop lint.

