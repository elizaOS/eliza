# @elizaos/prompts

Shared prompt templates for elizaOS.

The Stage-1 message-handler template uses the registered flat response schema:
`contexts`, `intents`, `candidateActionNames`, `facts`, `relationships`, and
`addressedTo`. Routing is derived by the runtime; the model is not asked to
invent retired `simple`, `requiresTool`, `parentActionHints`, `contextSlices`,
or nested `extract` fields. Complete history, provider data, context catalogs,
and registered field descriptions remain the responsibility of their existing
renderers. Changing this template does not truncate those inputs.

## Overview

This package is the single source of truth for prompt templates used by the runtime. Prompts are authored directly in `src/index.ts`.

## Structure

```
packages/prompts/
├── src/
│   ├── index.ts      # TypeScript prompt template exports
│   └── keywords.ts   # Authored multilingual keyword metadata
├── dist/             # generated JavaScript, declarations, and publish manifest
├── tsconfig.json     # package-owned source typecheck
└── scripts/          # Read-only inventory and secret checks
```

## Template Syntax

Prompts use Handlebars-style variables:

- `{{variableName}}` - simple variable substitution
- `{{#each items}}...{{/each}}` - iteration
- `{{#if condition}}...{{/if}}` - conditional

Use camelCase for variables (`{{agentName}}`, `{{providers}}`, `{{recentMessages}}`).

Action and provider metadata lives in the owning typed implementation. This package does not generate application source or alter another package during its build.

## Building

```bash
# Compile the publishable package
bun run build

# Compile only the native-Node package artifact
bun run build:package
```

Normal Node and Bun consumers load compiled JavaScript and declarations from
`dist`. Explicit `eliza-source` consumers and targeted test aliases can load the
maintained TypeScript source. Published runtime artifacts contain no source-only
entrypoints.

Package tests build distribution artifacts before exercising consumers.

## Usage

Plugins import authored templates directly and render their placeholders:

```typescript
import { REPLY_TEMPLATE } from "@elizaos/prompts";
import { composePrompt } from "@elizaos/core";

const prompt = composePrompt({
  state: { agentName: "Alice" },
  template: REPLY_TEMPLATE,
});
```

Core does not re-export the template catalog.

## Adding New Prompts

1. Add a `camelCaseTemplate` string export in `src/index.ts`.
2. Add the paired `UPPER_SNAKE_CASE_TEMPLATE` export.

## Template Guidelines

1. **Start with a task description** — begin prompts with `# Task:` to state the objective.
2. **Include providers placeholder** — use `{{providers}}` where provider context should be injected.
3. **Use JSON output format** — standardize on JSON response format for consistent parsing.
4. **Add clear instructions** — explicit instructions for the LLM.
5. **End with output format** — always specify the expected output format.

## Security & Privacy

- **Do not embed real secrets** in prompt templates. Prompts are source-controlled.
- **Avoid including PII** (emails, phone numbers, addresses, IDs) in templates or examples.
- Prefer placeholders (e.g., `{{apiKey}}`, `{{userEmail}}`) and inject only the minimum needed at runtime.

### Secret scan

```bash
bun run check:secrets
```

Scans `packages/prompts/src/**/*.ts`, plugin prompt TS modules (paths matching `prompts/**/*.ts`, `workflow-prompts/**/*.ts`, etc.), and a few explicit files — see `scripts/check-secrets.js`.

The default handler groups routing, reply, crisis and authority rules without repeating the same constraints. Literal recall from supplied evidence can answer directly; live records and effects still plan. Registered field contracts and source selection remain complete.
