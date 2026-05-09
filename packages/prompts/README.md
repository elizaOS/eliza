# @elizaos/prompts

Shared prompt templates and action specs for elizaOS.

## Overview

This package is the single source of truth for prompt templates used by the runtime. Prompts are authored directly as TypeScript modules under `src/` and re-exported from `src/index.ts`.

## Structure

```
packages/prompts/
├── src/              # TypeScript prompt template modules (source of truth)
│   ├── reply.ts
│   ├── choose_option.ts
│   ├── image_generation.ts
│   └── ...
├── specs/            # Action specs (JSON)
└── scripts/          # Spec + docs generators
    ├── generate-action-docs.js
    ├── generate-plugin-action-spec.js
    ├── prompt-compression.js
    └── check-secrets.js
```

## Template Syntax

Prompts use Handlebars-style variables:

- `{{variableName}}` - simple variable substitution
- `{{#each items}}...{{/each}}` - iteration
- `{{#if condition}}...{{/if}}` - conditional

Use camelCase for variables (`{{agentName}}`, `{{providers}}`, `{{recentMessages}}`).

## Building

```bash
# Generate plugin action spec + action docs
bun run build
```

## Usage

```typescript
import { REPLY_TEMPLATE, CHOOSE_OPTION_TEMPLATE } from "@elizaos/prompts";

const prompt = composePrompt({
  state: { agentName: "Alice" },
  template: REPLY_TEMPLATE,
});
```

## Adding New Prompts

1. Create a new `.ts` file in `src/` exporting a `*_TEMPLATE` constant.
2. Re-export it from `src/index.ts`.

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
npm run check:secrets
```

Scans `packages/prompts/src/**/*.ts` and `plugins/**/prompts/**/*.ts` for credential-like strings.
