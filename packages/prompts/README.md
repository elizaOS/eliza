# @elizaos/prompts

Shared prompt templates for elizaOS across TypeScript, Python, and Rust runtimes.

## Overview

This package provides a single source of truth for all prompt templates used by elizaOS agents. Prompts are stored as `.txt` files and generated into native formats for each language.

## Structure

```
packages/prompts/
├── prompts/           # Source prompt templates (.txt files)
│   ├── reply.txt
│   ├── choose_option.txt
│   ├── image_generation.txt
│   └── ...
├── scripts/           # Build scripts
│   └── generate.js    # Generates native code from prompts
├── dist/              # Generated output
│   ├── typescript/    # TypeScript exports
│   ├── python/        # Python module
│   └── rust/          # Rust source
└── package.json
```

## Template Syntax

All prompts use **Handlebars-style** template variables:

- `{{variableName}}` - Simple variable substitution
- `{{#each items}}...{{/each}}` - Iteration over arrays
- `{{#if condition}}...{{/if}}` - Conditional blocks

### Variable Naming Convention

Use camelCase for all template variables to ensure consistency across languages:

- `{{agentName}}` - The agent's name
- `{{providers}}` - Provider context
- `{{recentMessages}}` - Recent conversation messages

## Building

```bash
# Build all targets
npm run build

# Build specific target
npm run build:typescript
npm run build:python
npm run build:rust
```

## Usage

### TypeScript

```typescript
import { REPLY_TEMPLATE, CHOOSE_OPTION_TEMPLATE } from "@elizaos/prompts";

const prompt = composePrompt({
  state: { agentName: "Alice" },
  template: REPLY_TEMPLATE,
});
```

### Python

```python
from elizaos.prompts import REPLY_TEMPLATE, CHOOSE_OPTION_TEMPLATE

prompt = compose_prompt(state={'agentName': 'Alice'}, template=REPLY_TEMPLATE)
```

### Rust

```rust
use elizaos_prompts::{REPLY_TEMPLATE, CHOOSE_OPTION_TEMPLATE};

let prompt = compose_prompt(&state, REPLY_TEMPLATE);
```

## Adding New Prompts

1. Create a new `.txt` file in `prompts/` directory
2. Name the file using snake_case (e.g., `my_new_action.txt`)
3. Run `npm run build` to generate native code
4. The prompt will be exported as `MY_NEW_ACTION_TEMPLATE` in all languages

## Plugin Prompts

Plugins can use the same prompt system! See [README-PLUGIN-PROMPTS.md](./README-PLUGIN-PROMPTS.md) for details on how to set up prompts in your plugin.

The `scripts/generate-plugin-prompts.js` utility can be used by any plugin to generate TypeScript, Python, and Rust exports from `.txt` prompt templates.

## Template Guidelines

1. **Start with a task description** - Begin prompts with `# Task:` to clearly state the objective
2. **Include providers placeholder** - Use `{{providers}}` where provider context should be injected
3. **Use XML output format** - Standardize on XML response format for consistent parsing
4. **Add clear instructions** - Include explicit instructions for the LLM
5. **End with output format** - Always specify the expected output format

Example:

```txt
# Task: Generate dialog for the character {{agentName}}.

{{providers}}

# Instructions: Write the next message for {{agentName}}.

Respond using XML format like this:
<response>
    <thought>Your thought here</thought>
    <text>Your message here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.
```

## Security & Privacy Guidance (SOC2-aligned)

- **Do not embed real secrets** in prompt templates. Prompts are source-controlled and often distributed.
- **Avoid including PII** (emails, phone numbers, addresses, IDs) in templates or examples.
- Prefer placeholders (e.g., `{{apiKey}}`, `{{userEmail}}`) and ensure the runtime injects only the minimum needed.

### Secret scan

This package includes a conservative scanner that flags prompt templates containing strings that strongly resemble real credentials (or private key material).

Run:

```bash
npm run check:secrets
```

It scans:

- `packages/prompts/prompts/**/*.txt`
- `plugins/**/prompts/**/*.txt`
