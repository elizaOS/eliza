# Plugin Creation Examples

This directory contains several examples of how to use the ElizaOS plugin creation system.

## Prerequisites

Before running any of these examples, you need:

1. **Anthropic API Key**

   ```bash
   export ANTHROPIC_API_KEY='your-api-key'
   ```

2. **Claude Code CLI**
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

## Available Examples

### 1. Simple CLI Example (`generate-plugin-simple.sh`)

The simplest way to generate a plugin using the CLI directly:

```bash
./generate-plugin-simple.sh
```

This script:

- Uses the `elizaos plugins generate` command
- Skips tests and validation for faster execution
- Pipes in predefined inputs for a time-tracker plugin

### 2. Interactive CLI Example (`create-plugin-cli.sh`)

Full-featured script that uses the CLI with all options:

```bash
# Run with default settings (includes tests and validation)
./create-plugin-cli.sh

# Skip tests for faster generation
./create-plugin-cli.sh --skip-tests

# Skip both tests and validation
./create-plugin-cli.sh --skip-tests --skip-validation
```

Features:

- Command-line argument parsing
- Detailed logging
- Plugin structure inspection after generation
- Security-conscious API key handling

### 3. Demo Mode (`create-time-tracker-plugin-demo.sh`)

Optimized for demonstrations with detailed progress tracking:

```bash
./create-time-tracker-plugin-demo.sh
```

Features:

- Skips tests and validation by default
- Shows execution time
- Detailed progress indicators
- Shows generated plugin structure

### 4. Full Production Mode (`create-time-tracker-plugin.sh`)

Complete plugin generation with all validation steps:

```bash
./create-time-tracker-plugin.sh
```

Features:

- Full test execution loop
- Production readiness validation
- Secure API key input if not set
- Comprehensive error handling

### 5. Programmatic Example (`plugin-creator-example.ts`)

TypeScript example showing how to use the PluginCreator API directly:

```typescript
import { PluginCreator } from '../src/utils/plugins/creator';

const creator = new PluginCreator({
  skipPrompts: true,
  spec: {
    name: 'time-tracker',
    description: 'Time tracking plugin',
    features: ['Display time', 'Set timezone'],
    actions: ['displayTime', 'setOffset'],
    providers: ['timeProvider'],
  },
});

const result = await creator.create();
```

Run with:

```bash
npx tsx examples/plugin-creator-example.ts
```

## Time Tracker Plugin Specification

All examples generate a time-tracker plugin with:

- **Actions**:

  - `displayTime` - Shows current time
  - `setTimezoneOffset` - Sets timezone offset
  - `getTimeInZone` - Gets time in specific timezone

- **Providers**:
  - `currentTimeProvider` - Provides current time context
  - `timezoneProvider` - Provides timezone information

## Comparison

| Script                               | Tests | Validation | Speed | Use Case        |
| ------------------------------------ | ----- | ---------- | ----- | --------------- |
| `generate-plugin-simple.sh`          | ❌    | ❌         | Fast  | Quick demos     |
| `create-plugin-cli.sh`               | ✅\*  | ✅\*       | Slow  | Production      |
| `create-time-tracker-plugin-demo.sh` | ❌    | ❌         | Fast  | Presentations   |
| `create-time-tracker-plugin.sh`      | ✅    | ✅         | Slow  | Full production |

\*Configurable via command-line options

## Generated Plugin Structure

All scripts generate a plugin with this structure:

```
plugin-time-tracker/
├── src/
│   ├── index.ts
│   ├── actions/
│   │   ├── displayTime.ts
│   │   ├── setTimezoneOffset.ts
│   │   └── getTimeInZone.ts
│   └── providers/
│       ├── currentTimeProvider.ts
│       └── timezoneProvider.ts
├── tests/
│   ├── actions/
│   │   └── *.test.ts
│   └── providers/
│       └── *.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
└── PLUGIN_SPEC.md
```

## Tips

1. **For Development**: Use `--skip-tests --skip-validation` for faster iteration
2. **For Production**: Always run with full validation
3. **API Key Security**: Never commit scripts with hardcoded API keys
4. **Disk Space**: Ensure at least 2GB free space before running
5. **Network**: Stable internet connection required for AI calls

## Troubleshooting

If generation fails:

1. Check API key is valid
2. Verify Claude Code is installed: `claude --version`
3. Check disk space: `df -h`
4. Review logs in `./plugin-*-logs-*/`
5. Try with `--skip-tests` first to isolate issues
