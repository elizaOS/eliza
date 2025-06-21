# Running Plugin Test Scenarios

This guide explains how to run the plugin test scenarios for testing various plugin integrations in Eliza.

## Prerequisites

1. **Build the project**

   ```bash
   npm run build
   ```

2. **Set required environment variables**

   ```bash
   # Required for GitHub plugin tests
   export GITHUB_TOKEN=your_github_personal_access_token
   export GITHUB_OWNER=your_github_username_or_org  # Optional, defaults to 'elizaOS'
   export GITHUB_REPO=your_repo_name                # Optional, defaults to 'eliza'

   # Required for AI model interaction
   export OPENAI_API_KEY=your_openai_api_key
   # OR use another provider
   export ANTHROPIC_API_KEY=your_anthropic_api_key
   export MODEL_PROVIDER=anthropic
   ```

## Running Individual Scenario Tests

### GitHub-Todo Integration Test

This test validates the integration between GitHub issues and Todo task management:

```bash
# From the packages/cli directory
npm run test:github-todo

# Or using the CLI directly
node dist/index.js scenario test --scenarios 02-github-todo-workflow --verbose
```

### Running All Plugin Tests

To run all 50 plugin test scenarios:

```bash
# From the packages/cli directory
node dist/index.js scenario test --filter "plugin-tests/*" --verbose
```

### Running Specific Categories

```bash
# Research & Knowledge scenarios
node dist/index.js scenario test --filter "plugin-tests/*research*" --verbose

# Blockchain & DeFi scenarios
node dist/index.js scenario test --filter "plugin-tests/*blockchain*,plugin-tests/*defi*" --verbose

# Security scenarios
node dist/index.js scenario test --filter "plugin-tests/*security*" --verbose
```

## Understanding Test Results

The test runner will output:

- ✅ **PASSED** - Scenario completed successfully with expected outcomes
- ❌ **FAILED** - Scenario failed to meet verification criteria
- 🎯 **Actions Executed** - List of plugin actions that were triggered
- 💬 **Conversation Transcript** - Full conversation between tester and agent
- 📊 **Metrics** - Performance metrics and response times

## Expected Actions by Scenario

### 02-github-todo-workflow

- `LIST_GITHUB_ISSUES` - Fetch issues from GitHub
- `CREATE_TODO` - Create todo tasks from issues
- `UPDATE_TODO` - Update todo status
- `CREATE_GITHUB_PULL_REQUEST` - Create PR (optional)
- `LIST_TODOS` - List all todos

### 13-blockchain-analytics

- `FETCH_SOLANA_DEFI_DATA` - Get DeFi protocol data
- `ANALYZE_TOKEN_LIQUIDITY` - Analyze liquidity pools
- `GET_JUPITER_SWAP_QUOTE` - Get swap quotes
- `MONITOR_DEFI_POSITIONS` - Track positions

## Troubleshooting

### Missing Environment Variables

```bash
❌ Missing required environment variables: GITHUB_TOKEN, OPENAI_API_KEY
```

**Solution**: Set the required environment variables as shown in Prerequisites.

### Action Not Found

```
⚠️ Warning: Some expected actions were not executed
```

**Possible causes**:

- Plugin not properly initialized
- Action name mismatch (check actual action names in plugin source)
- Conversation flow didn't trigger the action

### Build Errors

```
Error: Cannot find module 'dist/index.js'
```

**Solution**: Run `npm run build` from the project root.

## Creating Custom Test Scenarios

1. Copy an existing scenario as a template
2. Update the action names to match real plugin actions
3. Define clear verification rules
4. Test with a character that has the required plugins

Example character configuration:

```json
{
  "name": "Test Agent",
  "plugins": ["@elizaos/plugin-github", "@elizaos/plugin-todo"],
  "system": "You are a helpful assistant that can manage GitHub issues and todos."
}
```

## Next Steps

To make these scenarios truly effective:

1. Verify all action names match actual plugin implementations
2. Add mock data for testing without real API calls
3. Create integration tests that validate actual API responses
4. Add performance benchmarks for each scenario
