# Plugin Scenario Runner Guide

## Understanding the Scenario Structure

Each scenario test consists of several key components:

### 1. Actors

- **Subject**: The agent being tested (has an empty script)
- **Tester**: Simulates user interactions with predefined messages and timing

### 2. Verification Rules

All verification rules must have `type: 'llm'` and include:

- `id`: Unique identifier
- `description`: What is being verified
- `config`: Contains verification criteria
  - For action verification: `expectedValue` should be the action name
  - For content verification: `criteria` should describe what to look for

### 3. Expected Actions

The scenarios expect specific plugin actions to be triggered:

- Research plugin: `start_research`, `refine_research_query`
- Knowledge plugin: `PROCESS_KNOWLEDGE`, `SEARCH_KNOWLEDGE`
- GitHub plugin: `LIST_GITHUB_ISSUES`, `CREATE_GITHUB_PR`
- Todo plugin: `CREATE_TODO`, `UPDATE_TODO`, `LIST_TODOS`
- Rolodex plugin: `CREATE_ENTITY`, `CREATE_RELATIONSHIP`
- etc.

## Running Scenarios

### Using the CLI Command

```bash
# Run a single scenario
npx elizaos scenario -s ./scenarios/plugin-tests/01-research-knowledge-integration.ts -v

# Run all scenarios in a directory
npx elizaos scenario -d ./scenarios/plugin-tests -v

# Run with benchmark mode
npx elizaos scenario -s <scenario-file> -b

# Save results to file
npx elizaos scenario -s <scenario-file> -o results.json --format json
```

### Prerequisites

1. Build the project: `npm run build`
2. Ensure you have a character configuration with required plugins
3. Set necessary environment variables (API keys, etc.)

## Common Issues and Solutions

### 1. Action Not Found

**Problem**: Expected actions are not being executed
**Solution**:

- Verify the plugin is loaded in your agent configuration
- Check that action names match the actual plugin implementation
- Ensure the conversation flow triggers the action

### 2. Verification Failures

**Problem**: LLM verification rules fail even when actions execute
**Solution**:

- Make criteria more specific and descriptive
- Include context about what the agent should do
- Check that the agent's response actually contains expected content

### 3. Plugin Not Loaded

**Problem**: Plugin functionality not available
**Solution**:

- Add plugin to agent's plugin list in character configuration
- Ensure plugin is properly installed and built
- Check for any plugin initialization errors

## Scenario Execution Flow

1. **Initialization**: Server and runtime are created with test agent
2. **Actor Setup**: Tester actor sends predefined messages
3. **Agent Response**: Subject agent processes messages and executes actions
4. **Verification**: Rules check if expected behaviors occurred
5. **Results**: Pass/fail status with detailed metrics

## Writing Effective Scenarios

### Good Verification Rule Example

```typescript
{
  id: 'action-executed',
  type: 'llm',
  description: 'Verify action was executed',
  config: {
    successCriteria: `
      Verify that the agent executed the CREATE_TODO action.
      Expected behavior:
      - User asks to create a todo
      - Agent acknowledges the request
      - Agent executes CREATE_TODO action
      - Agent confirms todo creation
    `.trim(),
    priority: 'high',
    category: 'action_execution',
    context: {
      expectedAction: 'CREATE_TODO'
    }
  },
  weight: 3
}
```

### Testing Strategy

1. Start with simple scenarios that test individual plugin functions
2. Progress to complex multi-plugin integration scenarios
3. Include error cases and edge conditions
4. Verify both action execution and response quality

## Debugging Tips

1. Use `-v` (verbose) flag to see detailed execution logs
2. Check agent logs for action execution details
3. Review conversation transcript in results
4. Use benchmark mode to identify performance issues
5. Test scenarios individually before batch execution
