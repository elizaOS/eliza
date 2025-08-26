# The ElizaOS Scenario System: A Definition

A **Scenario** is a declarative, human-readable definition of a task for an ElizaOS agent. It serves a dual purpose:

1.  As a high-level **integration test** to verify an agent's capabilities in a controlled, repeatable environment.
2.  As a reusable **workflow template** to execute complex, multi-step tasks in a live environment.

Scenarios are defined in `.yaml` files and are executed by a specialized **Scenario Runner** within the `elizaos` CLI. They are designed to bridge the gap between low-level unit/integration tests and high-level, goal-oriented agent behavior.

---

## Getting Started: A Conceptual Example

Imagine you want to verify that your agent can write a "Hello, World!" file. Instead of writing a complex test script, you would define a simple scenario:

```yaml
# A simple scenario to test file writing.
name: 'Verify Agent can write a file'
environment:
  type: e2b # Use a safe, sandboxed environment.
run:
  - input: "Please write 'Hello, World!' to a file named hello.txt"
    evaluations:
      - type: 'file_exists'
        path: 'hello.txt'
      - type: 'file_contains'
        path: 'hello.txt'
        value: 'Hello, World!'
```

When you run this with `elizaos scenario run` (or `bun packages/cli/dist/index.js scenario run` for local development), the system will spin up a sandbox, give the agent your instruction, and then check if the file was created with the correct content. This simple, readable format is the core of the Scenario System.

---

## Core Principles

- **Declarative & Human-Readable**: Scenarios should be easy to write and understand by developers, QA engineers, and even product managers. The YAML structure abstracts away the complex underlying test code.
- **Environment Agnostic**: Scenarios define _what_ the agent should do, not _where_. The same scenario can be executed against a local environment, a sandboxed cloud environment (like E2B), or a live production environment.
- **Composable & Reusable**: The building blocks of scenarios (setup steps, evaluators) are designed to be reusable across different tests.
- **Hybrid Execution**: Scenarios seamlessly support both mocked and live data/services, allowing for a flexible testing strategy that can evolve from pure simulation to live execution.

---

## Conceptual Components of a Scenario File

A scenario is defined in a YAML file and is conceptually composed of the following sections:

- **Metadata**: High-level information like a `name` and `description`.
- **Plugins**: A list of the required ElizaOS plugins the agent needs to run the scenario (e.g., `@elizaos/plugin-github`).
- **Environment**: Defines the execution environment for the agent (e.g., a local shell, a secure E2B sandbox).
- **Setup**: Defines the initial state of the world before the test runs. This can include:
  - **Seeding a database**: Can be defined via an inline list of records or a path to an external SQL file.
  - **Creating a virtual file system**: Can be defined via an inline map of file paths to content or a path to a directory to be mounted.
  - **Mocking external API calls**: Defining request/response pairs for mock servers to ensure tests are fast and deterministic.
- **Run**: Defines the task for the agent. This is typically a single, high-level input that leverages ElizaOS's built-in action chaining capabilities. The agent is expected to autonomously generate and execute a sequence of actions to fulfill the request.
- **Evaluations**: A set of assertions run after the agent completes its task. These are crucial for determining success and are broken into several categories:
  - **Response Evaluation**: Checks the agent's final, user-facing response (e.g., `string_contains`, `llm_judge`).
  - **Environment State Evaluation**: Checks for side-effects in the execution environment (e.g., `file_exists`, `command_exit_code_is`).
  - **Agent State Evaluation**: Checks the agent's internal state, such as its database, to see if it created new memories or updated its knowledge.
  - **Trajectory Evaluation**: Analyzes the sequence of actions the agent took to accomplish the goal by querying its internal logs. This is critical for assessing the agent's reasoning process. A correct final answer achieved via an illogical or incorrect path is still a failure. This helps identify when an agent is "correct for the wrong reasons" and allows for improving its planning and tool-selection capabilities.
- **Judgment**: The overall success criteria for the scenario (e.g., all evaluations must pass).

---

## The Scenario Runner CLI

Scenarios are executed via a dedicated top-level `elizaos scenario` command, which clearly separates scenario execution from standard testing (`elizaos test`) or running the agent server (`elizaos start`).

The runner supports two primary modes of operation on the same scenario file:

- **Test Mode**:
  - Production: `elizaos scenario run <scenario_file.yaml>`
  - Local Development: `bun packages/cli/dist/index.js scenario run <scenario_file.yaml>`
  - This is the default mode.
  - It provisions sandboxed environments, uses mocks, and seeds databases as defined in the file.
  - Its primary purpose is to output a pass/fail result for CI/CD and local development.
- **Live Mode**:
  - Production: `elizaos scenario run <scenario_file.yaml> --live`
  - Local Development: `bun packages/cli/dist/index.js scenario run <scenario_file.yaml> --live`
  - In this mode, the runner ignores mocks and database seeding instructions.
  - It connects to real databases and interacts with live third-party services as configured in the agent's environment.
  - Its purpose is to execute a proven, real-world workflow.

---

## Design Philosophy & Approach

This definition of the Scenario System is the result of careful consideration of both the unique challenges of testing AI agents and the current architecture of ElizaOS.

### Working with Eliza's Architecture

The Scenario System is designed specifically to test goal-oriented tasks that can be accomplished by ElizaOS's existing **linear action chaining** capability. In the current runtime, an agent formulates a pre-planned, sequential list of actions to execute in order to fulfill a user's request.

Our scenario framework directly supports this paradigm. It allows us to test the agent's ability to create a correct plan and the system's ability to execute it faithfully. This deliberate choice to work within the existing architectural constraints allows us to deliver a powerful, useful testing framework today.

### Why This Approach?

By focusing on a system that aligns with Eliza's current capabilities, we can:

1.  **Deliver Immediate Value**: Provide the development team with a much-needed, powerful testing and QA framework for the agent as it exists now. This helps us build more reliably and catch regressions in planning and tool-use.
2.  **Establish a Robust Foundation**: The core components of the Scenario System—the CLI runner, the declarative YAML structure, the mocking engine, and the context-aware evaluators—are fundamental building blocks. This creates a solid foundation that can be extended in the future to support a wide variety of even more complex scenarios as the agent's core capabilities evolve.
