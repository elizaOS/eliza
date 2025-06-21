# Quick Start: Plugin Scenario Testing

## Prerequisites

- Node.js installed
- OpenAI API key
- (Optional) GitHub token for GitHub-related scenarios

## One Command Setup & Test

From the `packages/cli` directory:

```bash
./setup-and-test-scenarios.sh sk-your-openai-api-key
```

This script will:

1. Build required plugins
2. Build the CLI
3. Clean test environment
4. Run the first scenario test
5. Show results

## Manual Testing

### 1. Set API Key

```bash
export OPENAI_API_KEY="sk-your-api-key"
```

### 2. Run Single Scenario

```bash
npx elizaos scenario --scenario ./scenarios/plugin-tests/01-research-knowledge-integration.ts --verbose
```

### 3. Run All Basic Scenarios (1-5)

```bash
./test-all-scenarios.sh sk-your-api-key [github-token]
```

## Expected Output

### Success

```
✅ PASS Academic Paper Research and Knowledge Storage (36.07s)
  Messages: 5
  Actions: 2+  <-- Should see actions executed
  Verification Results: ✓ (multiple passed rules)
```

### Common Failure

```
❌ FAIL Academic Paper Research and Knowledge Storage (36.07s)
  Messages: 5
  Actions: 0   <-- No actions executed
  Verification Results: ✗ (all failed)
```

## Troubleshooting

| Issue                     | Solution                                                 |
| ------------------------- | -------------------------------------------------------- |
| "Mock response" in output | Set OPENAI_API_KEY                                       |
| Actions: 0                | Check API key is valid                                   |
| Plugin not found          | Build plugin first: `cd ../plugin-name && npm run build` |
| Database error            | Delete `.scenario-test-db` folder                        |

## Available Scenarios

1. **01-research-knowledge-integration** - Research & Knowledge plugins
2. **02-github-todo-workflow** - GitHub & Todo plugins (needs GitHub token)
3. **03-planning-execution** - Planning plugin
4. **04-rolodex-relationship-management** - Rolodex plugin
5. **05-stagehand-web-research** - Stagehand plugin

## Need Help?

- Full guide: `RUNNING-TESTS.md`
- Technical details: `SCENARIO-RUNNER-GUIDE.md`
- Implementation notes: `IMPLEMENTATION-SUMMARY.md`
