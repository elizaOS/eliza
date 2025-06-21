# Environment Normalization in ElizaOS CLI

This document explains how the ElizaOS CLI handles different runtime environments and ensures consistent behavior across TypeScript development and JavaScript production environments.

## Overview

The ElizaOS CLI can run in multiple environments:

1. **TypeScript Development** (using `bun run`)
2. **JavaScript Production** (using `elizaos` command)
3. **Inside Monorepo** (development within the ElizaOS repository)
4. **Standalone Projects** (separate projects using ElizaOS)

Each environment has different requirements for imports, file extensions, and module resolution.

## Key Differences

### TypeScript Environment (`bun run`)

- Can import `.ts` files directly without extensions
- No need for `.js` extensions on relative imports
- Direct access to TypeScript source files
- Typically used during development

### JavaScript Environment (`elizaos` command)

- Requires `.js` extensions on all relative imports
- Cannot import `.ts` files directly
- Works with compiled/built JavaScript files
- Used in production and when installed via npm

## Environment Detection

The CLI automatically detects the current environment:

```typescript
import { detectRuntimeEnvironment, getEnvironmentConfig } from '@elizaos/cli';

const env = detectRuntimeEnvironment(); // 'typescript' | 'javascript'
const config = getEnvironmentConfig();
// {
//   isTypeScript: boolean,
//   isMonorepo: boolean,
//   requiresJsExtensions: boolean,
//   canRunTypeScriptDirectly: boolean
// }
```

## Import Path Normalization

The CLI automatically normalizes import paths based on the environment:

```typescript
import { normalizeImportPath } from '@elizaos/cli';

// In TypeScript environment:
normalizeImportPath('./utils'); // Returns: './utils'

// In JavaScript environment:
normalizeImportPath('./utils'); // Returns: './utils.js'

// Package imports are never modified:
normalizeImportPath('@elizaos/core'); // Always: '@elizaos/core'
```

## Best Practices

### 1. Writing Plugins

When writing plugins that work in both environments:

```typescript
// Always use explicit extensions in built files
// src/index.ts (source)
import { myUtil } from './utils'; // OK for TypeScript

// dist/index.js (built)
import { myUtil } from './utils.js'; // Required for JavaScript
```

### 2. Character Files

Character files should use environment-agnostic plugin references:

```json
{
  "name": "MyAgent",
  "plugins": [
    "@elizaos/plugin-message-handling", // Published plugins
    "./local-plugin" // Local plugins (CLI handles resolution)
  ]
}
```

### 3. Project Structure

#### Project Starter Template

```
my-project/
├── package.json
├── .env
├── characters/
│   └── main.json
├── src/
│   └── index.js       # JavaScript for compatibility
└── plugins/           # Local plugins
    └── my-plugin/
        ├── package.json
        └── dist/
            └── index.js
```

#### Plugin Starter Template

```
my-plugin/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts      # TypeScript source
├── dist/
│   └── index.js      # Built JavaScript
└── examples/
    └── character.json
```

## Common Issues and Solutions

### Issue 1: "Cannot find module" errors in production

**Problem**: Missing `.js` extensions in built files.

**Solution**: Ensure your build process adds `.js` extensions to relative imports:

```json
// tsconfig.json
{
  "compilerOptions": {
    "module": "ES2022",
    "moduleResolution": "node"
  }
}
```

### Issue 2: Plugin not loading in different environments

**Problem**: Plugin expects TypeScript but running in JavaScript environment.

**Solution**: Always build plugins before use:

```bash
# In plugin directory
bun run build

# Then use the plugin
elizaos start --character character.json
```

### Issue 3: Different behavior in monorepo vs standalone

**Problem**: Workspace protocol differences.

**Solution**: Use the CLI's project initialization:

```bash
# Create a properly configured project
elizaos create my-project
cd my-project
elizaos start
```

## Testing Across Environments

Run comprehensive tests to ensure compatibility:

```bash
# Test in TypeScript environment
bun run test

# Test in JavaScript environment (built CLI)
bun run build
elizaos test

# Test specific scenarios
bun test tests/bats/commands/start-comprehensive.bats
```

## Environment Variables

The CLI respects these environment variables:

- `NODE_ENV`: Set to `test` during testing
- `TS_NODE`: Indicates TypeScript execution
- `ELIZA_NO_AUTO_INSTALL`: Prevents automatic plugin installation

## Migration Guide

### From `bun run` to `elizaos`

1. Build all TypeScript files to JavaScript
2. Add `.js` extensions to all relative imports in built files
3. Ensure `package.json` has proper `exports` field
4. Test with `elizaos start` command

### From Standalone to Monorepo Development

1. Clone the ElizaOS repository
2. Link your project/plugin to the monorepo
3. Use workspace protocol in dependencies
4. Run with `bun run` from monorepo root

## Debugging

Enable debug logging to see environment detection:

```bash
# See which environment is detected
DEBUG=eliza:* elizaos start

# Check import resolution
DEBUG=eliza:import elizaos start
```

## Summary

The environment normalization system ensures that:

1. **Developers** can work with TypeScript without friction
2. **Production** users get a working JavaScript CLI
3. **Plugins** work consistently across environments
4. **Projects** are portable between development and production

By following these guidelines and using the provided utilities, you can create agents, plugins, and projects that work seamlessly across all supported environments.
