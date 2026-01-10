# Plugin Prompt System

This document describes how to use the shared prompt system for elizaOS plugins.

## Overview

Plugins can now use a centralized prompt system similar to the core `@elizaos/prompts` package. This eliminates the need to duplicate prompts across TypeScript, Python, and Rust implementations.

## Structure

Each plugin that uses prompts should have:

```
plugin-name/
├── prompts/              # Source prompt templates (.txt files)
│   ├── my_action.txt
│   └── my_provider.txt
├── dist/
│   └── prompts/         # Generated output (auto-generated)
│       ├── typescript/
│       ├── python/
│       └── rust/
└── package.json          # Should include build:prompts script
```

## Setup

### 1. Create Prompts Directory

Create a `prompts/` directory in your plugin root and add `.txt` files:

```bash
mkdir -p plugins/your-plugin/prompts
```

### 2. Add Prompt Templates

Create `.txt` files with your prompt templates using Handlebars-style syntax:

```txt
# prompts/my_action.txt
# Task: Perform {{actionName}}

## Context
{{context}}

## Instructions
{{instructions}}

Return your response in XML format:
<response>
  <result>{{result}}</result>
</response>
```

### 3. Add Build Script

Add a build script to your `package.json`:

```json
{
  "scripts": {
    "build:prompts": "node ../../packages/prompts/scripts/generate-plugin-prompts.js ./prompts ./dist/prompts --target all",
    "build": "npm run build:prompts && ..."
  }
}
```

### 4. Generate Prompts

Run the build script:

```bash
npm run build:prompts
```

This generates:
- `dist/prompts/typescript/prompts.ts` - TypeScript exports
- `dist/prompts/python/prompts.py` - Python module
- `dist/prompts/rust/prompts.rs` - Rust constants

## Usage

### TypeScript

```typescript
import { MY_ACTION_TEMPLATE } from '../dist/prompts/typescript/prompts.js';
import { composePrompt } from '@elizaos/core';

const prompt = composePrompt({
  state: {
    actionName: 'create',
    context: 'user request',
    instructions: 'be helpful'
  },
  template: MY_ACTION_TEMPLATE
});
```

### Python

```python
from dist.prompts.python.prompts import MY_ACTION_TEMPLATE

prompt = MY_ACTION_TEMPLATE.replace("{{actionName}}", "create") \
                           .replace("{{context}}", "user request") \
                           .replace("{{instructions}}", "be helpful")
```

### Rust

```rust
use crate::prompts::MY_ACTION_TEMPLATE;

let prompt = MY_ACTION_TEMPLATE
    .replace("{{actionName}}", "create")
    .replace("{{context}}", "user request")
    .replace("{{instructions}}", "be helpful");
```

## Shared Types

The `@elizaos/core` package exports shared types for prompt building:

```typescript
import type { PromptFieldInfo, BuildPromptOptions, BuiltPrompt } from '@elizaos/core';
```

### PromptFieldInfo

Used when building prompts that extract or format field values:

```typescript
const field: PromptFieldInfo = {
  id: 'email',
  type: 'email',
  label: 'Email Address',
  description: 'Your email address',
  criteria: 'Must be a valid email'
};
```

### BuildPromptOptions

Options for building a prompt from a template:

```typescript
const options: BuildPromptOptions = {
  template: MY_TEMPLATE,
  state: {
    userName: 'Alice',
    userAge: 30
  },
  defaults: {
    userName: 'User'
  }
};
```

## Best Practices

1. **Single Source of Truth**: Keep all prompts in `.txt` files, never edit generated code
2. **Consistent Naming**: Use snake_case for `.txt` files (e.g., `form_extraction.txt`)
3. **Template Variables**: Use camelCase for template variables (e.g., `{{userName}}`)
4. **Build Integration**: Always run `build:prompts` before building your plugin
5. **Version Control**: Commit `.txt` files, but add `dist/prompts/` to `.gitignore` if desired

## Example: Plugin Forms

The `plugin-forms` package demonstrates this pattern:

- **Source**: `plugins/plugin-forms/prompts/form_extraction.txt`
- **Generated**: `plugins/plugin-forms/dist/prompts/typescript/prompts.ts`
- **Usage**: `plugins/plugin-forms/typescript/utils/prompt-builders.ts`

See the plugin-forms implementation for a complete example.

## Migration Guide

To migrate an existing plugin:

1. Extract prompts from TypeScript/Python/Rust files into `.txt` files
2. Create `prompts/` directory and add `.txt` files
3. Add `build:prompts` script to `package.json`
4. Run `npm run build:prompts`
5. Update imports to use generated prompts
6. Remove old prompt definitions from language-specific files

## Troubleshooting

### Prompts not generating

- Ensure `prompts/` directory exists and contains `.txt` files
- Check that the script path is correct in `package.json`
- Verify Node.js is available in your build environment

### Import errors

- Ensure `build:prompts` runs before your main build
- Check that generated files exist in `dist/prompts/`
- Verify import paths match your project structure

### Template variables not working

- Use Handlebars syntax: `{{variableName}}`
- Ensure variable names use camelCase
- Check that `composePrompt` is used for TypeScript (handles Handlebars)

