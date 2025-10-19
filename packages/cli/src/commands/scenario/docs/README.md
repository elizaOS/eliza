# ElizaOS Scenario Testing & Matrix Runner Guide

This guide covers the comprehensive scenario testing and matrix runner functionality implemented through Epic [#5781](https://github.com/elizaOS/eliza/issues/5781) and associated tickets.

## Overview

The ElizaOS Scenario System provides powerful testing capabilities for agents in both local and sandboxed environments. Each scenario is defined in YAML and can include:

- Environment setup and isolation
- Mock service responses
- Action tracking and trajectory analysis
- Multi-format evaluation criteria
- Matrix testing with parameter combinations
- Comprehensive reporting (JSON, HTML, PDF)
- Final judgment rules with LLM evaluation

## ✅ Completed Features (Epic #5781)

The scenario system has been significantly enhanced with the following completed features:

### 🎯 **Matrix Runner & Reporting System**

- **Parameter Matrix Testing**: Run scenarios across multiple parameter combinations
- **Comprehensive Reporting**: Generate JSON, HTML, and PDF reports automatically
- **Organized Output**: All results saved to `@scenario/_logs_/` with timestamped folders
- **Trajectory Analysis**: Track agent thought processes and action sequences
- **Success Rate Analytics**: Detailed metrics and performance analysis

### 📊 **Enhanced Evaluation System**

- **Structured Evaluations**: Enhanced evaluation results with success/failure details
- **Trajectory Tracking**: Monitor agent cognitive processes step-by-step
- **LLM Judge Integration**: AI-powered evaluation of agent responses
- **Multi-format Output**: Support for various evaluation result formats

### 🔧 **Improved Infrastructure**

- **Run Isolation**: Complete isolation between test runs
- **Resource Monitoring**: Track memory, CPU, and disk usage
- **Progress Tracking**: Real-time progress updates during matrix execution
- **Error Handling**: Comprehensive error capture and reporting
- **Plugin Management**: Dynamic plugin loading with dependency resolution

## Demo Videos

- https://drive.google.com/file/d/19oo2V_NfKZCJHuAdcRN3c2l2iTiXiWzd/view?usp=sharing
- https://drive.google.com/file/d/1fkKx8zphsDZpB8QrHy1F7oKnntqs6-0b/view?usp=sharing
- https://drive.google.com/file/d/1uUhCCqjCdcCv9mQS5CQrkj-mXOO4nC3z/view?usp=sharing
- https://drive.google.com/file/d/1OquQX7rn77iOH-njjU68k7KzjxsOtvWx/view?usp=sharing

## 🚀 Quick Start

### **Available Command Options**

#### **Production Commands (Recommended)**

For production use with globally installed CLI:

```bash
# Run a single scenario
elizaos scenario run <scenario-file> [options]

# Run matrix testing with parameter combinations
elizaos scenario matrix <matrix-config> [options]

# Generate comprehensive reports
elizaos report generate <input-directory> [options]
```

#### **Local Development Commands**

For local development and testing:

```bash
# Run a single scenario
bun packages/cli/dist/index.js scenario run <scenario-file> [options]

# Run matrix testing with parameter combinations
bun packages/cli/dist/index.js scenario matrix <matrix-config> [options]

# Generate comprehensive reports
bun packages/cli/dist/index.js report generate <input-directory> [options]
```

#### **Command Options**

**Scenario Run Options:**

- `--live` - Run in live mode, ignoring mocks (default: false)

**Matrix Options:**

- `--dry-run` - Show matrix analysis without executing tests
- `--parallel <number>` - Maximum parallel test runs (default: 1)
- `--filter <pattern>` - Filter parameter combinations by pattern
- `--verbose` - Show detailed progress information

**Report Options:**

- `--output-path <path>` - Path where report files will be saved
- `--format <format>` - Output format: "json", "html", "pdf", or "all" (default: "all")

> **Note**: Local commands require running from the project root directory and building the CLI first with `bun run build` in the `packages/cli` directory.

### **Available Scenario Types**

**Important**: Run all scenario commands from the project root directory for plugins to be loaded correctly.

#### 1. Single Scenario Tests

**Basic Single-Turn Tests:**

**Production Commands:**

```bash
# Run a simple local test
elizaos scenario run packages/cli/src/commands/scenario/examples/simple-test.scenario.yaml

# Run action tracking test
elizaos scenario run packages/cli/src/commands/scenario/examples/action-tracking-test.scenario.yaml

# Run evaluation test
elizaos scenario run packages/cli/src/commands/scenario/examples/evaluation-test.scenario.yaml

# Run basic conversation test
elizaos scenario run packages/cli/src/commands/scenario/examples/basic-conversation.scenario.yaml
```

**Local Development Commands:**

```bash
# Run a simple local test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/simple-test.scenario.yaml

# Run action tracking test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/action-tracking-test.scenario.yaml

# Run evaluation test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/evaluation-test.scenario.yaml

# Run basic conversation test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/basic-conversation.scenario.yaml
```

#### 2. E2B Sandboxed Tests

**Production Commands:**

```bash
# Run E2B environment test
elizaos scenario run packages/cli/src/commands/scenario/examples/e2b-test.scenario.yaml

# Run E2B fallback test
elizaos scenario run packages/cli/src/commands/scenario/examples/e2b-fallback.scenario.yaml

# Run mock E2B test
elizaos scenario run packages/cli/src/commands/scenario/examples/mock-e2b-test.scenario.yaml
```

**Local Development Commands:**

```bash
# Run E2B environment test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/e2b-test.scenario.yaml

# Run E2B fallback test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/e2b-fallback.scenario.yaml

# Run mock E2B test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/mock-e2b-test.scenario.yaml
```

#### 3. Mock Service Tests

**Production Commands:**

```bash
# Run simple mock test
elizaos scenario run packages/cli/src/commands/scenario/examples/simple-mock-test.scenario.yaml

# Run full mock test
elizaos scenario run packages/cli/src/commands/scenario/examples/mock-test.scenario.yaml
```

**Local Development Commands:**

```bash
# Run simple mock test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/simple-mock-test.scenario.yaml

# Run full mock test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/mock-test.scenario.yaml
```

#### 4. LLM Judge Tests

**Production Commands:**

```bash
# Run LLM judgment test
elizaos scenario run packages/cli/src/commands/scenario/examples/llm-judge-test.scenario.yaml

# Run LLM judgment failure test
elizaos scenario run packages/cli/src/commands/scenario/examples/llm-judge-failure-test.scenario.yaml
```

**Local Development Commands:**

```bash
# Run LLM judgment test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/llm-judge-test.scenario.yaml

# Run LLM judgment failure test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/llm-judge-failure-test.scenario.yaml
```

#### 5. Matrix Testing (NEW!)

**Production Commands:**

```bash
# Run matrix testing with parameter combinations
elizaos scenario matrix packages/cli/src/commands/scenario/examples/github-issue-analysis.matrix.yaml

# Run simple matrix test
elizaos scenario matrix packages/cli/src/commands/scenario/examples/simple-test.matrix.yaml
```

**Local Development Commands:**

```bash
# Run matrix testing with parameter combinations
bun packages/cli/dist/index.js scenario matrix packages/cli/src/commands/scenario/examples/github-issue-analysis.matrix.yaml

# Run simple matrix test
bun packages/cli/dist/index.js scenario matrix packages/cli/src/commands/scenario/examples/simple-test.matrix.yaml
```

#### 6. Conversation Tests (NEW!)

**Production Commands:**

```bash
# Run basic conversation test
elizaos scenario run packages/cli/src/commands/scenario/examples/basic-conversation.scenario.yaml

# Run advanced conversation scenarios
elizaos scenario run packages/cli/src/commands/scenario/examples/customer-support.scenario.yaml
elizaos scenario run packages/cli/src/commands/scenario/examples/technical-interview.scenario.yaml
```

**Local Development Commands:**

```bash
# Run basic conversation test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/basic-conversation.scenario.yaml

# Run advanced conversation scenarios
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/customer-support.scenario.yaml
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/technical-interview.scenario.yaml
```

#### 7. Other Test Types

**Production Commands:**

```bash
# Run multi-step scenario
elizaos scenario run packages/cli/src/commands/scenario/examples/multi-step.scenario.yaml

# Run mixed results test
elizaos scenario run packages/cli/src/commands/scenario/examples/mixed-results.scenario.yaml

# Run trajectory test
elizaos scenario run packages/cli/src/commands/scenario/examples/trajectory-test.scenario.yaml
```

**Local Development Commands:**

```bash
# Run multi-step scenario
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/multi-step.scenario.yaml

# Run mixed results test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/mixed-results.scenario.yaml

# Run trajectory test
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/trajectory-test.scenario.yaml
```

## 📊 **Reporting & Analysis (NEW!)**

### **Automatic Report Generation**

The scenario system now automatically generates comprehensive reports in multiple formats:

**Production Commands:**

```bash
# Generate all report formats (JSON, HTML, PDF) in organized folders
elizaos report generate packages/cli/src/commands/scenario/_logs_

# Generate specific format only
elizaos report generate packages/cli/src/commands/scenario/_logs_ --format json
elizaos report generate packages/cli/src/commands/scenario/_logs_ --format html
elizaos report generate packages/cli/src/commands/scenario/_logs_ --format pdf
```

**Local Development Commands:**

```bash
# Generate all report formats (JSON, HTML, PDF) in organized folders
bun packages/cli/dist/index.js report generate packages/cli/src/commands/scenario/_logs_

# Generate specific format only
bun packages/cli/dist/index.js report generate packages/cli/src/commands/scenario/_logs_ --format json
bun packages/cli/dist/index.js report generate packages/cli/src/commands/scenario/_logs_ --format html
bun packages/cli/dist/index.js report generate packages/cli/src/commands/scenario/_logs_ --format pdf
```

### **Organized Output Structure**

All results are automatically organized in the simplified `@scenario/_logs_/` structure:

```
packages/cli/src/commands/scenario/_logs_/
├── run-001.json                    # Individual scenario results
├── run-002.json
├── matrix-2025-08-17.../          # Matrix execution results
└── run-2025-08-17_16-43-39/       # Generated reports
    ├── README.md                   # Auto-generated summary
    ├── report.json                 # Raw data & analysis (5KB)
    ├── report.html                 # Interactive web report (56KB)
    └── report.pdf                  # Print-ready report (304KB)
```

### **Report Features**

- **JSON Reports**: Raw data for programmatic analysis
- **HTML Reports**: Interactive web interface with charts and filtering
- **PDF Reports**: Professional print-ready reports
- **Auto-Documentation**: README files with run summaries
- **Success Analytics**: Success rates, execution times, trajectory patterns

## 🔄 **Running Multiple Scenarios**

### **Sequential Execution**

**Production Commands:**

```bash
# Run all scenarios in sequence
elizaos scenario run packages/cli/src/commands/scenario/examples/*.scenario.yaml
```

**Local Development Commands:**

```bash
# Run all scenarios in sequence
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/*.scenario.yaml
```

### **Matrix Execution**

**Production Commands:**

```bash
# Run matrix testing with parameter combinations
elizaos scenario matrix packages/cli/src/commands/scenario/examples/github-issue-analysis.matrix.yaml
```

**Local Development Commands:**

```bash
# Run matrix testing with parameter combinations
bun packages/cli/dist/index.js scenario matrix packages/cli/src/commands/scenario/examples/github-issue-analysis.matrix.yaml
```

## 🛠️ **Troubleshooting**

### **Plugin Loading Issues**

If you encounter issues with plugins not being loaded during scenario testing:

1. **Ensure you're running from the project root directory**

   **Production Commands:**

   ```bash
   # Always run scenario commands from the project root
   cd /path/to/eliza
   elizaos scenario run <scenario-file>
   ```

   **Local Development Commands:**

   ```bash
   # Always run scenario commands from the project root
   cd /path/to/eliza
   bun packages/cli/dist/index.js scenario run <scenario-file>
   ```

2. **If plugins still fail to load, add them as dependencies**

   ```bash
   # From the project root directory
   bun add elizaos/plugin-name
   ```

   Common plugin examples:

   ```bash
   bun add elizaos/plugin-bootstrap
   bun add elizaos/plugin-sql
   bun add elizaos/plugin-quick-starter
   ```

3. **Verify plugin installation**
   ```bash
   # Check if the plugin is listed in package.json dependencies
   cat package.json | grep "elizaos/"
   ```

This approach ensures that the plugin is properly installed and available for the ElizaOS runtime to load during scenario execution.

## 🔧 **Development & Building**

### **Building the CLI**

After making changes to the scenario system:

```bash
# Build from CLI directory
cd packages/cli
bun run build

# Or build from project root
bun run build
```

### **Testing Changes**

**Production Commands:**

```bash
# Test scenario functionality
elizaos scenario run packages/cli/src/commands/scenario/examples/simple-test.scenario.yaml

# Test matrix functionality
elizaos scenario matrix packages/cli/src/commands/scenario/examples/simple-test.matrix.yaml

# Test report generation
elizaos report generate packages/cli/src/commands/scenario/_logs_
```

**Local Development Commands:**

```bash
# Test scenario functionality
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/simple-test.scenario.yaml

# Test matrix functionality
bun packages/cli/dist/index.js scenario matrix packages/cli/src/commands/scenario/examples/simple-test.matrix.yaml

# Test report generation
bun packages/cli/dist/index.js report generate packages/cli/src/commands/scenario/_logs_
```

## 🔑 **Environment Setup**

### **Required Environment Variables**

```env
E2B_API_KEY=your_key_here      # Required for E2B sandboxed tests
OPENAI_API_KEY=your_key_here   # Required for LLM judge evaluations
```

### **Local Development Setup**

```bash
# Install dependencies
cd packages/cli
bun install

# Build the CLI
bun run build
```

### **Verify Setup**

**Production Commands (if CLI is globally installed):**

```bash
# Test that the CLI works correctly
elizaos --help

# Test a simple scenario (from project root)
elizaos scenario run packages/cli/src/commands/scenario/examples/simple-test.scenario.yaml

# Test matrix functionality
elizaos scenario matrix packages/cli/src/commands/scenario/examples/simple-test.matrix.yaml

# Test report generation
elizaos report generate packages/cli/src/commands/scenario/_logs_
```

**Local Development Commands:**

```bash
# Test that the CLI builds correctly
bun packages/cli/dist/index.js --help

# Test a simple scenario (from project root)
bun packages/cli/dist/index.js scenario run packages/cli/src/commands/scenario/examples/simple-test.scenario.yaml

# Test matrix functionality
bun packages/cli/dist/index.js scenario matrix packages/cli/src/commands/scenario/examples/simple-test.matrix.yaml

# Test report generation
bun packages/cli/dist/index.js report generate packages/cli/src/commands/scenario/_logs_
```

## Scenario File Structure

### Single-Turn Scenario

```yaml
name: 'Test Name'
description: 'Test Description'
environment:
  type: 'local' # or "e2b"
  setup:
    # Environment-specific setup
mocks:
  - service: 'ServiceName'
    method: 'methodName'
    response: {}
run:
  - input: 'User input'
evaluations:
  - type: 'string_contains'
    value: 'expected text'
  - type: 'llm_judge'
    prompt: 'Evaluation question'
    expected: 'Expected answer'
judgment:
  strategy: 'all_pass'
```

### Conversation Scenario (NEW!)

```yaml
name: 'Conversation Test Name'
description: 'Test Description'
plugins:
  - '@elizaos/plugin-bootstrap'
  - '@elizaos/plugin-openai'
environment:
  type: 'local' # or "e2b"
run:
  - name: 'Conversation Name'
    input: 'Initial user message'

    conversation:
      max_turns: 4
      user_simulator:
        persona: 'Description of simulated user'
        objective: 'What the user wants to achieve'
        temperature: 0.6
        style: 'Communication style'
        constraints:
          - 'Behavioral constraint 1'
          - 'Behavioral constraint 2'

      termination_conditions:
        - type: 'user_expresses_satisfaction'
          keywords: ['thank you', 'resolved', 'perfect']
        - type: 'agent_provides_solution'
          keywords: ['follow these steps', 'issue resolved']

      turn_evaluations:
        - type: 'llm_judge'
          prompt: 'Per-turn evaluation question'
          expected: 'yes'

      final_evaluations:
        - type: 'llm_judge'
          prompt: 'Overall conversation evaluation'
          expected: 'yes'
          capabilities:
            - 'Capability 1'
            - 'Capability 2'
        - type: 'conversation_length'
          min_turns: 2
          max_turns: 6
          optimal_turns: 3

    # Traditional evaluations still supported
    evaluations:
      - type: 'string_contains'
        value: 'help'
judgment:
  strategy: 'all_pass'
```

### Example Single-Turn Scenario

```yaml
name: 'Simple File Creation Test'
description: 'Tests basic file creation in local environment'
environment:
  type: 'e2b'
  setup:
    workingDirectory: '/tmp/test'
mocks:
  - service: 'FileService'
    method: 'createFile'
    response:
      success: true
      path: '/tmp/test/example.txt'
run:
  - input: 'Create a file called example.txt'
evaluations:
  - type: 'file_exists'
    path: '/tmp/test/example.txt'
  - type: 'llm_judge'
    prompt: 'Did the agent successfully create the file?'
    expected: 'yes'
judgment:
  strategy: 'all_pass'
```

### Example Conversation Scenario

```yaml
name: 'Customer Support Conversation'
description: 'Tests multi-turn customer support capabilities'
plugins:
  - '@elizaos/plugin-bootstrap'
  - '@elizaos/plugin-openai'
environment:
  type: 'local'
run:
  - name: 'Billing Support'
    input: 'Hi, I need help with my billing'

    conversation:
      max_turns: 4
      user_simulator:
        persona: 'customer with a billing question'
        objective: 'find out why charged twice this month'
        temperature: 0.6
        style: 'polite and patient'
        constraints:
          - 'Be polite and cooperative'
          - 'Provide details when asked'
          - 'Express gratitude for help'

      termination_conditions:
        - type: 'user_expresses_satisfaction'
          keywords: ['thank you', 'resolved', 'perfect']
        - type: 'agent_provides_solution'
          keywords: ['follow these steps', 'issue resolved']

      turn_evaluations:
        - type: 'llm_judge'
          prompt: 'Did the agent respond helpfully and professionally?'
          expected: 'yes'

      final_evaluations:
        - type: 'llm_judge'
          prompt: 'Was the billing issue successfully resolved?'
          expected: 'yes'
          capabilities:
            - "Understood the customer's billing concern"
            - 'Asked appropriate follow-up questions'
            - 'Provided helpful solutions'
judgment:
  strategy: 'all_pass'
```

## 🗣️ **Conversation Features (NEW!)**

### **Dynamic Prompting & User Simulation**

The scenario system now supports sophisticated multi-turn conversations with:

- **User Simulator**: AI-powered user that maintains personas, objectives, and behavioral constraints
- **Dynamic Responses**: Context-aware responses that adapt to conversation flow
- **Intelligent Termination**: Natural conversation endings based on satisfaction or solution detection
- **Turn-based Evaluation**: Real-time assessment of each conversation turn
- **Persona Consistency**: Maintains character traits and objectives across turns
- **Context Retention**: Remembers conversation history and builds upon it
- **Emotional Intelligence**: Handles emotional states and progression
- **Flexible Termination**: Multiple termination strategies including LLM-based decisions

### **Conversation Configuration Options**

```yaml
conversation:
  max_turns: 6 # Maximum conversation length
  user_simulator:
    persona: 'customer support' # Character description
    objective: 'resolve billing' # What user wants to achieve
    temperature: 0.6 # Response creativity (0.0-1.0)
    style: 'professional' # Communication style
    constraints: # Behavioral rules
      - 'Be polite and patient'
      - 'Provide details when asked'

  termination_conditions: # When to end conversation
    - type: 'user_expresses_satisfaction'
      keywords: ['thank you', 'resolved']
    - type: 'agent_provides_solution'
      keywords: ['follow these steps']

  turn_evaluations: # Evaluate each turn
    - type: 'llm_judge'
      prompt: 'Was this response helpful?'
      expected: 'yes'

  final_evaluations: # Evaluate overall conversation
    - type: 'llm_judge'
      prompt: 'Was the issue resolved?'
      expected: 'yes'
      capabilities:
        - 'Understood the problem'
        - 'Provided solutions'
    - type: 'conversation_length'
      min_turns: 2
      max_turns: 8
      optimal_turns: 4
```

### **New Evaluation Types**

#### **Conversation-Specific Evaluators:**

- **`conversation_length`**: Validates conversation turn count
  - Parameters: `min_turns`, `max_turns`, `optimal_turns`, `target_range`
- **`conversation_flow`**: Detects required conversation patterns
  - Parameters: `required_patterns`, `flow_quality_threshold`
  - Patterns: `question_then_answer`, `problem_then_solution`, `clarification_cycle`, `empathy_then_solution`, `escalation_pattern`
- **`user_satisfaction`**: Measures user satisfaction level
  - Parameters: `satisfaction_threshold`, `indicators`, `measurement_method`
  - Methods: `keyword_analysis`, `sentiment_analysis`, `llm_judge`
- **`context_retention`**: Tests agent memory across turns
  - Parameters: `test_memory_of`, `retention_turns`, `memory_accuracy_threshold`

### Usage notes

Occasionally there were some embedding issues with GPT-5 models, so if you run into issues append your `.env` file with:

```bash
# Use a specific embedding model to avoid GPT-5 embedding issues
OPENAI_SMALL_MODEL="gpt-4o-mini"
SMALL_MODEL="gpt-4o-mini"
OPENAI_LARGE_MODEL="gpt-4o"
LARGE_MODEL="gpt-4o"
OPENAI_EMBEDDING_MODEL="text-embedding-3-small"

```

#### **Enhanced Core Evaluators:**

- **`llm_judge`**: Now supports `capabilities` parameter for detailed assessment
  - Enhanced Parameters: `prompt`, `expected`, `capabilities`, `json_schema`, `model_type`, `temperature`
- **Turn Evaluations**: All existing evaluators can now run per-turn
- **Final Evaluations**: Separate evaluation set for conversation completion
- **Multi-level Assessment**: Turn-level, flow-level, and outcome-level evaluations

## Implementation Details

The scenario system is built on several key components:

1. **YAML Parser** ([#5574](https://github.com/elizaOS/eliza/issues/5574))
   - Validates scenario file structure
   - Provides type-safe scenario configuration

2. **Environment Providers**
   - Local ([#5575](https://github.com/elizaOS/eliza/issues/5575))
   - E2B Sandbox ([#5576](https://github.com/elizaOS/eliza/issues/5576))

3. **Mock Engine** ([#5577](https://github.com/elizaOS/eliza/issues/5577))
   - Service call interception
   - Response mocking

4. **Evaluation Engine** ([#5578](https://github.com/elizaOS/eliza/issues/5578))
   - Action tracking
   - Response validation
   - Trajectory analysis
   - Conversation evaluation
   - Turn-based assessment
   - User simulation

5. **Final Judgment** ([#5579](https://github.com/elizaOS/eliza/issues/5579))
   - LLM-based judgment
   - User-facing reports

## Common Issues

1. **E2B Hanging**: If E2B tests hang, check:
   - E2B_API_KEY is set correctly
   - Network connectivity
   - E2B service status
   - Plugin loading issues (check logs for plugin loading steps)
   - Database initialization problems

2. **Mock Failures**: For mock test failures:
   - Verify mock service name matches exactly
   - Check response format matches service expectations
   - Ensure all required methods are mocked

3. **Evaluation Failures**: For evaluation issues:
   - Check evaluator configuration
   - Verify expected responses match format
   - Review action tracking configuration

4. **Plugin Loading Issues**: If plugins are not being loaded correctly:
   - Ensure you're running commands from the project root directory
   - If plugins still fail to load, run `bun add elizaos/plugin-name` from the root directory
   - This will add the plugin as a dependency and ensure it's available for loading
   - Example: `bun add elizaos/plugin-bootstrap` or `bun add elizaos/plugin-sql`

## Contributing

When adding new scenarios:

1. Place YAML files in `src/commands/scenario/examples/`
2. Follow existing naming conventions
3. Include comprehensive descriptions
4. Add to this documentation

## 📋 **Best Practices**

### **Conversation Design Principles**

#### **Start Simple**

```yaml
# Begin with basic 2-3 turn conversations
conversation:
  max_turns: 3
  user_simulator:
    persona: 'straightforward user with simple goal'
    objective: 'basic problem resolution'
```

#### **Gradual Complexity**

```yaml
# Build up to complex multi-persona scenarios
conversation:
  max_turns: 8
  user_simulator:
    persona: 'complex user with evolving needs'
    emotional_state: 'initially frustrated, becomes cooperative'
    constraints:
      - 'Start with complaints'
      - 'Become helpful when shown empathy'
```

### **User Simulator Best Practices**

#### **Persona Consistency**

```yaml
user_simulator:
  persona: 'experienced developer who values efficiency'
  style: 'direct, technical, impatient with basic explanations'
  knowledge_level: 'expert'
  constraints:
    - 'Use technical terminology correctly'
    - 'Skip basic explanations'
    - 'Ask detailed implementation questions'
```

#### **Realistic Objectives**

```yaml
user_simulator:
  # Good: Specific, measurable objective
  objective: 'configure SSL certificate for production deployment'

  # Avoid: Vague objective
  # objective: "get help with website"
```

### **Performance Considerations**

#### **Resource Management**

```yaml
conversation:
  max_turns: 6 # Reasonable limit to prevent infinite loops
  timeout_per_turn_ms: 30000 # 30 second timeout per turn
  total_timeout_ms: 300000 # 5 minute total conversation timeout
```

#### **LLM Usage Optimization**

```yaml
user_simulator:
  model_type: 'TEXT_LARGE' # Use appropriate model size
  temperature: 0.7 # Balance creativity and consistency
  max_tokens: 150 # Limit response length
```

### **Matrix Testing with Conversations**

```yaml
name: 'Conversation Matrix Testing'
base_scenario: 'customer-support.scenario.yaml'
runs_per_combination: 2

matrix:
  # Test different user personas
  - parameter: 'run[0].conversation.user_simulator.persona'
    values:
      - 'frustrated customer'
      - 'confused beginner'
      - 'experienced power user'
      - 'non-native English speaker'

  # Test different conversation lengths
  - parameter: 'run[0].conversation.max_turns'
    values: [3, 5, 8]

  # Test different termination conditions
  - parameter: 'run[0].conversation.termination_conditions[0].type'
    values:
      - 'user_expresses_satisfaction'
      - 'agent_provides_solution'
      - 'escalation_needed'
```

## 📚 **References & Epic Information**

### **Epic #5781: Scenario Matrix Runner and Reporting System**

This comprehensive system was implemented through Epic [#5781](https://github.com/elizaOS/eliza/issues/5781) with the following components:

- **Matrix Runner**: Parameter combination testing across multiple scenarios
- **Reporting System**: Multi-format output (JSON, HTML, PDF) with organized structure
- **Trajectory Analysis**: Agent cognitive process tracking and analysis
- **Enhanced Evaluations**: Structured evaluation results with detailed metrics
- **Resource Monitoring**: Memory, CPU, and disk usage tracking
- **Progress Tracking**: Real-time execution progress updates
- **Dynamic Prompting**: Multi-turn conversations with user simulation

### **Original Implementation References**

- [CLI Command Implementation](https://github.com/elizaOS/eliza/issues/5573)
- [YAML Parser](https://github.com/elizaOS/eliza/issues/5574)
- [Local Environment](https://github.com/elizaOS/eliza/issues/5575)
- [E2B Integration](https://github.com/elizaOS/eliza/issues/5576)
- [Mock Engine](https://github.com/elizaOS/eliza/issues/5577)
- [Evaluation Engine](https://github.com/elizaOS/eliza/issues/5578)
- [Final Judgment](https://github.com/elizaOS/eliza/issues/5579)

### **New Features (Epic #5781)**

- [Matrix Runner Implementation](https://github.com/elizaOS/eliza/issues/5782)
- [Reporting System](https://github.com/elizaOS/eliza/issues/5783)
- [Trajectory Analysis](https://github.com/elizaOS/eliza/issues/5784)
- [Enhanced Evaluations](https://github.com/elizaOS/eliza/issues/5785)
- [Data Aggregation](https://github.com/elizaOS/eliza/issues/5786)
- [Resource Monitoring](https://github.com/elizaOS/eliza/issues/5787)
- [Progress Tracking](https://github.com/elizaOS/eliza/issues/5788)
- [Run Isolation](https://github.com/elizaOS/eliza/issues/5789)
- [Error Handling](https://github.com/elizaOS/eliza/issues/5790)
