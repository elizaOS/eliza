# Running Plugin Scenario Tests

This guide explains how to run the plugin scenario tests using the `elizaos scenario` command.

## Prerequisites

1. **Build the CLI**:

   ```bash
   cd packages/cli
   npm run build
   ```

2. **API Keys Required**:
   - **OpenAI API Key** (REQUIRED): For LLM responses
   - **GitHub Token** (Optional): For GitHub-related scenarios
   - **Other API Keys**: Depending on which scenarios you run

## Quick Start

### Run a Single Scenario

```bash
# From packages/cli directory
export OPENAI_API_KEY="sk-your-api-key"
npx elizaos scenario --scenario ./scenarios/plugin-tests/01-research-knowledge-integration.ts --verbose
```

### Run All Scenarios

```bash
# From packages/cli directory
./test-all-scenarios.sh sk-your-openai-api-key [github-token]
```

## Understanding Test Results

### What the Tests Check

Each scenario verifies:

1. **Action Execution**: Whether the correct plugin actions were triggered
2. **Integration Flow**: Whether multiple plugins work together properly
3. **Response Quality**: Whether the agent provides appropriate responses
4. **Data Flow**: Whether data is properly stored and retrieved

### Common Issues and Solutions

#### 1. "Mock response for testing purposes"

**Issue**: The LLM is not being called
**Solution**: Ensure your OpenAI API key is set correctly

#### 2. No actions executed (Actions: 0)

**Issue**: The agent isn't triggering plugin actions
**Solution**:

- Check that plugins are loaded (see initialization logs)
- Verify the character configuration includes necessary plugins
- Ensure the system prompt guides the agent to use actions

#### 3. Database errors

**Issue**: SQLite/PostgreSQL compatibility issues
**Solution**: The scenario runner uses SQLite in-memory database

#### 4. Plugin not found

**Issue**: Plugin package not built
**Solution**: Build the plugin first:

```bash
cd ../plugin-name
npm run build
cd ../cli
```

## Scenario Details

### 01. Research Knowledge Integration

- **Plugins**: research, knowledge
- **Tests**: Deep research workflow with knowledge storage
- **Required**: OpenAI API key

### 02. GitHub Todo Workflow

- **Plugins**: github, todo
- **Tests**: GitHub issue to todo task management
- **Required**: OpenAI API key, GitHub token

### 03. Planning Execution

- **Plugins**: planning
- **Tests**: Multi-step planning and execution
- **Required**: OpenAI API key

### 04. Rolodex Relationship Management

- **Plugins**: rolodex
- **Tests**: Contact and relationship tracking
- **Required**: OpenAI API key

### 05. Stagehand Web Research

- **Plugins**: stagehand
- **Tests**: Web scraping and research
- **Required**: OpenAI API key

## Debugging Tips

1. **Enable Verbose Mode**: Always use `--verbose` flag
2. **Check Logs**: Look for plugin initialization messages
3. **Save Results**: Use `--output results.json --format json`
4. **Isolated Testing**: Test one scenario at a time first

## Environment Variables

Create a `.env` file in packages/cli:

```env
OPENAI_API_KEY=sk-your-api-key
GITHUB_TOKEN=github_pat_your_token
LOG_LEVEL=info
TELEMETRY_DISABLED=true
```

## Next Steps

Once basic scenarios pass:

1. Test more complex multi-plugin scenarios
2. Add custom verification rules
3. Create project-specific test scenarios
4. Set up CI/CD integration

## Troubleshooting Checklist

- [ ] CLI is built (`npm run build`)
- [ ] OpenAI API key is set
- [ ] Required plugins are built
- [ ] Character file includes needed plugins
- [ ] System prompt guides action usage
- [ ] No conflicting global packages

For more details, see the scenario runner implementation in `src/commands/scenario/`.
