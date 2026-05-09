# DELETED.md

Audit trail for the aggressive prune of `@elizaos/workflows`.

## Why

The only external consumer of this package is `plugins/plugin-workflow/`,
which imports exactly five types from it:

- `INode`
- `INodeCredentialsDetails`
- `INodeProperties`
- `INodeTypeDescription`
- `IWorkflowSettings`

Everything else in the package was n8n-derived runtime (expression evaluator,
sandboxing, workflow data proxy, native-method shims, extensions, helpers,
schema/validation pipelines, error class hierarchy) that no consumer in this
monorepo invoked. The package exported a 22.5K-LOC type/runtime forest where
plugin-workflow only needed five `interface`/`type` declarations.

## Approach

`packages/workflows/src/` was collapsed to a single `index.ts` that defines
the five keep types and their transitive type closure inline. Every other
source file was deleted outright. Inner types whose shape is not exercised by
plugin-workflow (e.g. `IWorkflowsRequestOperations`, `requestDefaults`) are
kept as opaque `unknown` aliases.

## What was deleted

Whole files / directories (all under `packages/workflows/src/`):

- `interfaces.ts` (3775 LOC) — replaced by hand-written `index.ts`
- `workflow.ts`, `workflow-data-proxy.ts`, `workflow-data-proxy-helpers.ts`,
  `workflow-data-proxy-env-provider.ts`, `workflow-expression.ts`,
  `workflow-checksum.ts`, `workflow-diff.ts`, `workflow-environments-helper.ts`,
  `workflow-structure-validation.ts`, `workflow-validation.ts`
- `expression.ts`, `expression-evaluator-proxy.ts`, `expression-sandboxing.ts`
- `expressions/`, `extensions/`, `native-methods/`
- `errors/` and `workflows-errors/` (entire directories)
- `run-execution-data/`, `run-execution-data-factory.ts`
- `node-helpers.ts`, `node-validation.ts`, `node-parameters/`,
  `node-reference-parser-utils.ts`
- `schemas.ts`, `types.d.ts`, `data-table.types.ts`
- `common/`, `graph/`, `connections-diff.ts`
- `cron.ts`, `message-event-bus.ts`, `global-state.ts`,
  `logger-proxy.ts`, `observable-object.ts`, `metadata-utils.ts`
- `augment-object.ts`, `deferred-promise.ts`, `evaluation-helpers.ts`,
  `execution-context.ts`, `execution-context-establishment-hooks.ts`,
  `execution-status.ts`, `from-ai-parse-utils.ts`, `highlighted-data.ts`,
  `result.ts`, `tool-helpers.ts`, `trimmed-task-data.ts`, `type-guards.ts`,
  `type-validation.ts`, `utils.ts`, `versioned-node-type.ts`,
  `constants.ts`

`package.json` devDependencies pruned from 14 entries to 3
(`@biomejs/biome`, `@types/node`, `typescript`). All runtime
`dependencies` removed (axios, lodash, luxon, ast-types, esprima-next,
form-data, jmespath, js-base64, jsonrepair, jssha, md5, recast,
title-case, transliteration, uuid, xml2js, zod). Optional peer
dependencies (`@codemirror/autocomplete`, `@types/express`) and their
metadata block also removed — they were only used by deleted code.

## Verification

- `bun run build` — clean (`tsc -p tsconfig.build.json`, 0 errors).
- `bun test __tests__` — 6/6 pass (smoke test).
- `cd plugins/plugin-workflow && bun test __tests__/unit` — 169 pass / 4 fail,
  identical to baseline (the 4 failures pre-date this prune; all in
  `EmbeddedWorkflowService` and network-related).

## Restoring functionality

If a future consumer needs richer type detail (e.g. `INodeTypeDescription.requestOperations`
typed instead of `unknown`), add it directly to `src/index.ts`. Do not
re-introduce side modules — keeping the surface in one file is the point of
this refactor.
