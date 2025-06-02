# ElizaOS Plugin Creator

This directory contains the AI-powered plugin generation system for ElizaOS, which automatically creates complete, production-ready plugins from high-level specifications.

## Overview

The Plugin Creator uses Claude Code and Claude Opus 4 to generate entire ElizaOS plugins from scratch, including:

- Complete implementation of all components (actions, providers, evaluators, services)
- Comprehensive test suites
- Proper documentation
- Production-ready code with no stubs or TODOs

## Usage

```bash
elizaos plugins generate [options]
```

### Options

- `--api-key <key>`: Provide Anthropic API key (alternative to ANTHROPIC_API_KEY env var)
- `--skip-tests`: Skip the automated test validation loop
- `--skip-validation`: Skip the production readiness validation
- `--skip-prompts`: Skip interactive prompts (requires pre-defined spec)

### Examples

```bash
# Interactive plugin generation
elizaos plugins generate

# Quick generation without validation
elizaos plugins generate --skip-tests --skip-validation

# Non-interactive with API key
elizaos plugins generate --api-key sk-ant-... --skip-prompts
```

## How It Works

### 1. Specification Collection

The creator collects plugin requirements through interactive prompts:

- Plugin name
- Description
- Key features
- Components needed (actions, providers, evaluators, services)
- Specific component names and purposes

### 2. Template Creation

- Creates plugin structure from plugin-starter template
- Falls back to manual structure creation if template unavailable
- Initializes git repository for version control

### 3. Specification Generation

- Uses Claude Opus 4 to generate detailed technical specification
- Creates comprehensive architecture and implementation plan
- Generates PLUGIN_SPEC.md with all requirements

### 4. Code Generation

- Claude Code reads the specification and implements the entire plugin
- Creates all components with full functionality
- Generates comprehensive test suites

### 5. Validation Loops

#### Build Loop

- Runs `npm install` and `npm run build`
- If build fails, re-engages Claude Code with error context
- Continues up to 5 iterations until build passes

#### Test Loop (if not skipped)

- Runs `npm test` to validate functionality
- If tests fail, provides errors to Claude Code for fixes
- Continues up to 5 iterations until all tests pass

#### Production Validation (if not skipped)

- Sends all code to Claude Opus 4 for review
- Evaluates against production readiness criteria
- If not ready, applies revision instructions
- Continues up to 3 revision iterations

### 6. Output

- Copies complete plugin to current directory
- Provides usage instructions
- Ready for immediate use in ElizaOS projects

## Example: Time Tracker Plugin

Here's an example of creating a time tracking plugin:

```bash
$ elizaos plugins generate

? Plugin name (without "plugin-" prefix): time-tracker
? Plugin description: A plugin to display time and manage timezone offsets
? Main features (comma-separated): Display current time, Set timezone offset, Get time in different zones
? Which components will this plugin include? Actions, Providers
? Action names (comma-separated): displayTime, setOffset
? Provider names (comma-separated): timeProvider

🚀 Starting AI-powered plugin generation...

✓ Plugin specification collected
✓ Plugin structure created
✓ Detailed specification generated
✓ Specification document created
✓ Plugin code generated and validated

✅ Plugin successfully generated!
   Name: time-tracker
   Location: ./plugin-time-tracker

Next steps:
1. cd plugin-time-tracker
2. Review the generated code
3. Run tests: npm test
4. Add to your ElizaOS project
```

## Requirements

1. **Anthropic API Key**: Required for AI-powered generation

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

2. **Claude Code CLI**: Must be installed globally

   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

3. **Disk Space**: Minimum 2GB free space required

## Architecture

### Files

- `creator.ts`: Main plugin creation logic
- `README.md`: This documentation

### Key Classes

- `PluginCreator`: Orchestrates the entire creation process
  - `create()`: Main entry point
  - `collectPluginSpecification()`: Interactive prompt handling
  - `runGenerationWithValidation()`: Manages all validation loops
  - `validateProductionReadiness()`: AI-powered code review

## Generated Plugin Structure

```
plugin-name/
├── src/
│   ├── index.ts          # Main plugin export
│   ├── actions/          # Action implementations
│   ├── providers/        # Provider implementations
│   ├── evaluators/       # Evaluator implementations
│   └── services/         # Service implementations
├── tests/                # Comprehensive test suites
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── tsup.config.ts        # Build configuration
├── vitest.config.ts      # Test configuration
├── README.md             # Plugin documentation
└── PLUGIN_SPEC.md        # Detailed specification
```

## Safety Features

1. **Process Management**

   - Graceful shutdown on interruption
   - Claude Code process timeout (15 minutes)
   - Automatic cleanup on failure

2. **Validation**

   - Build must pass
   - Tests must pass (unless skipped)
   - Production readiness check (unless skipped)

3. **Error Recovery**
   - Iterative fixing of build/test failures
   - AI-powered error resolution
   - Maximum iteration limits to prevent infinite loops

## Best Practices

1. **Clear Specifications**: Provide detailed descriptions and feature lists
2. **Component Planning**: Think through which components you need
3. **Review Generated Code**: Always review the AI-generated code
4. **Test Thoroughly**: Run additional manual tests beyond automated ones
5. **Customize as Needed**: The generated code is a starting point

## Troubleshooting

### "Claude Code not found"

Install Claude Code globally:

```bash
npm install -g @anthropic-ai/claude-code
```

### "ANTHROPIC_API_KEY is required"

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Build or tests keep failing

Try skipping validation and fixing manually:

```bash
elizaos plugins generate --skip-tests --skip-validation
```

### Insufficient disk space

Ensure at least 2GB free space in your temp directory.

## Advanced Usage

### Programmatic Creation

```typescript
import { PluginCreator } from '@elizaos/cli';

const creator = new PluginCreator({
  skipPrompts: true,
  spec: {
    name: 'my-plugin',
    description: 'My custom plugin',
    features: ['Feature 1', 'Feature 2'],
    actions: ['action1', 'action2'],
    providers: ['provider1'],
  },
});

const result = await creator.create();
```

## Contributing

To improve the plugin creator:

1. Enhance specification templates
2. Add more component templates
3. Improve error handling
4. Add more validation criteria
5. Extend test generation capabilities

## Future Enhancements

1. **Plugin Templates**: Pre-defined templates for common plugin types
2. **Dependency Analysis**: Automatic detection of required dependencies
3. **Integration Tests**: Generate integration tests with other plugins
4. **Documentation Generation**: Create user-facing documentation
5. **Example Generation**: Create usage examples automatically
