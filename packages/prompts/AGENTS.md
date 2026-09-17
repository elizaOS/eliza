# `@elizaos/prompts`

Single source of truth for the LLM prompt templates the elizaOS runtime uses,
Action and provider metadata belongs to the owning typed plugin implementation.

Repository-wide engineering and evidence requirements are inherited from the
root [`CLAUDE.md`](../../CLAUDE.md).

## Purpose / role

- Holds every shared prompt template as a plain string export in `src/index.ts`.
  `@elizaos/core` re-exports these via `packages/core/src/prompts.ts`, and
  `plugins/plugin-assistant/src/features/autonomy/service.ts` consumes the autonomy
  templates. The runtime fills `{{...}}` placeholders with `composePrompt` from
  core.
- Retains `compressPromptDescription` as a deprecated identity alias for
  backward compatibility. Runtime and codegen paths use complete authored
  descriptions directly; the alias must never rewrite text.
- Keeps a read-only lexical action inventory for repository navigation. There
  are no generated action/provider specs or cross-package source writes.
- Explicit `eliza-source` consumers and targeted test aliases load maintained
  TypeScript. Normal Node and Bun consumers use compiled `dist` artifacts.
  The package exports its root, keywords, and package manifest.
  Internal source imports use explicit `.js` specifiers so NodeNext typechecking
  and emitted native ESM resolve the same sibling modules.

## Layout

```
packages/prompts/
  src/index.ts        Shared prompt templates; each exported twice:
                      camelCaseTemplate + UPPER_SNAKE_CASE_TEMPLATE alias.
                      Also re-exports the lossless compatibility alias.
  src/prompt-compression.ts  lossless compatibility alias for authored descriptions
  scripts/
    registered-action-inventory.js  read-only discovery of authored action definitions
    check-secrets.js                scans prompt .ts files for embedded secrets/PII
    file-utils.js                   readJson/readText/ensureDirectory helpers for the scripts
  test/prompts.test.js  rendered composition, injection, and lossless-context contracts (bun test)
```

## Key exports / surface

`src/index.ts` only. Each template is exported under two names — the camelCase form and an UPPER_SNAKE_CASE alias (e.g. `replyTemplate` / `REPLY_TEMPLATE`). Notable ones: `MESSAGE_HANDLER_TEMPLATE`, `REPLY_TEMPLATE`, `SHOULD_RESPOND_TEMPLATE`, `SHOULD_RESPOND_WITH_CONTEXT_TEMPLATE`, `PLANNER_TEMPLATE`, `REFLECTION_TEMPLATE`, `FACT_EXTRACTION_TEMPLATE`, `DEFAULT_CHARACTER_SYSTEM_TEMPLATE`, the `AUTONOMY_*` family, the `SHOULD_(FOLLOW|MUTE|UNFOLLOW|UNMUTE)_ROOM_TEMPLATE` set, the contact templates (`ADD_/REMOVE_/UPDATE_CONTACTS` / `SEARCH_CONTACTS`), and `BOOLEAN_FOOTER`. Import templates from `@elizaos/core` in runtime code; prompts package tooling and tests import directly from `@elizaos/prompts` / `src/index.ts`.

## Commands

```bash
bun run --cwd packages/prompts build                    # compile package artifacts
bun run --cwd packages/prompts build:package            # compile the native-Node publish artifact
bun run --cwd packages/prompts check:secrets            # scan prompt files for secrets/PII
bun run --cwd packages/prompts test                     # bun test ./test
bun run --cwd packages/prompts typecheck                # typecheck both maintained TypeScript modules
bun run --cwd packages/prompts lint                     # biome check --write
bun run --cwd packages/prompts lint:check               # biome check (no write)
bun run --cwd packages/prompts format:check             # biome format check
bun run --cwd packages/prompts clean                    # rm -rf dist
```

`typecheck` uses the package-owned NodeNext `tsconfig.json` over the two
maintained source modules. The package test lane builds and packs `dist/`
exactly as the release path does, verifies that the tarball contains the
compiled `dist/` contract rather than TypeScript runtime source, installs it
into an isolated native Node consumer, and proves that all published
source-facing conditions still load compiled JavaScript. It separately
exercises Bun's workspace resolution, native Node's compiled workspace entry,
Vitest-compatible Vite resolution of core with `dist/` removed, and clean core
declaration emission; any path failing is a package-contract error.

## Config / env vars

No required configuration. The read-only inventory accepts a repository root and writes no files.


## How to extend

Add a prompt template:
1. In `src/index.ts`, add `export const fooTemplate = \`...\`;` then `export const FOO_TEMPLATE = fooTemplate;` (always export both names).
2. Use `{{camelCaseVar}}` placeholders, `{{#each}}` / `{{#if}}`, and end with the JSON-only output instruction other templates use.
3. Re-export from `@elizaos/core` (`packages/core/src/prompts.ts`) if runtime code needs it, then add or adjust a regression test for an observable composition, injection, lossless-context, or code-generation boundary. Do not add tests whose material assertion only pins prompt prose.

Edit action metadata in the owning plugin and test its observable behavior.

## Conventions / gotchas

- Never embed secrets or PII in templates (they are source-controlled); use placeholders. `check:secrets` enforces this over prompt `.ts` files — see the path/regex list in `scripts/check-secrets.js`.
- Never cap, condense, summarize, abbreviate, or otherwise rewrite model-facing
  prompt content. Provider limits reject before dispatch; explicit pagination
  must be lossless and caller requested.
- Test observable rendered contracts rather than prompt wording. Prose-only
  regex and substring assertions create copy-edit churn without proving model-facing behavior.

## Package completion evidence

Follow the repository-wide definition of done in the root guide. For prompt or
template changes, inspect the diff and run prompt
and secret tests. A deterministic test or guide change that does not alter a
model-facing prompt needs rendered-contract evidence, not a live-model run.
When prompt behavior changes, execute the affected behavior against a live model
and review the full trajectory—including rendered prompt, raw output,
validation, action selection, and result.

The authored default handler consolidates duplicate rules and distinguishes literal supplied-history recall from current-record reads. Keep live-state/effect routing, owner-goal versus work-task routing, untrusted-input boundaries, secret protection and explicit memory mutations intact when editing it. This does not change runtime context renderers or impose history limits.

For navigation-only turns, the model drafts a concise destination confirmation that the runtime holds until successful receipt-grounded execution. Other planning replies remain acknowledgments; a navigation confirmation cannot claim a record read or mutation.

Exact dialogue quotations may use supplied original message text and authors directly. Missing evidence, absent requested source metadata, explicit history searches and exhaustive stored-history coverage retain authorized retrieval; honor user restrictions on lookup. This does not treat prior dialogue as current live-record state or permit invented provenance.

The default handler uses one concise routing/reply contract while retaining authority and secret boundaries. Domain examples name only the needed operation: a navigation-only request does not select record siblings, and an owner reminder operation does not also select an alternative TRIGGER family. Context catalogs, registered field descriptions, original dialogue, custom prompt resolution and runtime execution gates are unchanged. Validate routing against real model traces rather than asserting prompt wording.

The custom universal personal-crisis deferral block was removed at the user's request. Do not restore it as part of unrelated prompt cleanup.

Action and provider metadata is authored in the owning implementation. Do not generate source in core or scan other packages during builds. Builds emit only distribution artifacts.

`src/keywords.ts` owns the multilingual keyword table used by core and shared matching helpers. Author changes there directly; do not add generators or copies to consumers.
