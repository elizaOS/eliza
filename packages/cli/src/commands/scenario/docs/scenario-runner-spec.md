# ElizaOS Scenario Runner: Technical Specification

This document provides a detailed technical specification for the `elizaos scenario` command-line tool. It is intended for developers working on or extending the Scenario Runner's functionality.

For a high-level overview of the "why" behind this system, please see [`scenarios.md`](./scenarios.md).

---

## 1. CLI Command Architecture

The Scenario Runner is exposed through the main `elizaos` CLI application.

- **Command**: `elizaos scenario run [filePath]`
- **Arguments**:
  - `filePath`: The required path to the `.scenario.yaml` file to be executed.
- **Options**:
  - `--live`: (Boolean, default: `false`) When this flag is present, the runner will execute in "Live Mode," which ignores all `setup.mocks` and connects to real services.
  - `--env-file`: (String) Path to a custom `.env` file to load for the execution.

The command will be registered within the `packages/cli` using the `yargs` library, similar to other commands like `test` and `start`.

---

## 2. Execution Flow

The Scenario Runner follows a strict, sequential lifecycle to ensure repeatable and predictable test execution.

```mermaid
graph TD
    A[Start: elizaos scenario run] --> B{Parse Scenario YAML};
    B --> C{Validate Schema};
    C --> D{Initialize Environment Provider};
    D --> E{Execute 'setup' Block};
    E --> F[Execute 'run' Block];
    F --> G[Execute 'evaluations' Block];
    G --> H{Process 'judgment'};
    H --> I[Output Final Result];

    subgraph "Loading Phase"
        B
        C
    end

    subgraph "Environment Setup Phase"
        D
        E
    end

    subgraph "Agent Execution Phase"
        F
    end

    subgraph "Verification & Reporting Phase"
        G
        H
        I
    end
```

1.  **Parse YAML**: Read the file from disk and parse it using `js-yaml`.
2.  **Validate Schema**: The parsed object is validated against a set of TypeScript interfaces to ensure it is well-formed. Mismatches will cause an immediate exit with a clear error.
3.  **Initialize Environment Provider**: Based on the `environment.type` field (`e2b` or `local`), instantiate the corresponding provider. If `e2b` is specified, the runner will verify that the `@elizaos/plugin-e2b` is available.
4.  **Execute `setup` Block**: The runner sequentially processes the `setup` instructions:
    - **Mocks**: The Mocking Engine (see below) is configured.
    - **Virtual FS**: Files are written to the environment via the provider.
    - **Database Seeding**: The database adapter is called to execute seeding.
5.  **Execute `run` Block**: The `run.input` is sent to the agent within the configured environment. The runner waits for the agent to complete the task.
6.  **Execute `evaluations` Block**: Each item in the `evaluations` array is executed by the Evaluation Engine.
7.  **Process `judgment`**: The results of the evaluations are aggregated based on the `judgment.strategy`.
8.  **Output Result**: A summary of the run is printed to the console, including the final pass/fail status and details on any failed evaluations. The process exits with code `0` for success and `1` for failure.

---

## 3. Environment Provider Interface

To abstract the execution context, the runner uses an `EnvironmentProvider` interface.

```typescript
// in packages/cli/src/scenarios/providers/types.ts

interface FileSystemOperation {
  type: 'write';
  path: string;
  content: string;
}

interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  files: Record<string, string>; // A map of file paths to their content after execution.
}

interface EnvironmentProvider {
  /**
   * Prepares the environment, including setting up the file system.
   */
  setup(fs: FileSystemOperation[]): Promise<void>;

  /**
   * Executes a command within the environment.
   */
  run(command: string): Promise<ExecutionResult>;

  /**
   * Cleans up any resources created during the run.
   */
  teardown(): Promise<void>;
}
```

- **`LocalEnvironmentProvider`**: Implements the interface using Node.js `child_process` for execution and `fs` for file operations on the host machine.
- **`E2BEnvironmentProvider`**: Implements the interface by calling the `@elizaos/plugin-e2b` service. It uses `e2bService.writeFileToSandbox()` and `e2bService.runCommand()` under the hood.

---

## 4. Mocking Engine Internals

The mocking engine's goal is to intercept calls to service methods without modifying the agent's source code. This will be achieved via monkey-patching the `AgentRuntime`.

The proposed mechanism is to add a method to the `AgentRuntime` itself:

```typescript
// in packages/core/src/runtime.ts
class AgentRuntime {
  // ... existing properties

  private mockRegistry: Map<string, Function> = new Map();

  public getService<T>(name: string): T {
    const serviceMethodKey = `${name}.${methodName}`; // e.g., "github-service.readFile"
    if (this.mockRegistry.has(serviceMethodKey)) {
      // Return a proxy that calls the mock function
    }
    // ... existing logic
  }

  public registerMock(serviceMethodKey: string, mockFunction: Function) {
    this.mockRegistry.set(serviceMethodKey, mockFunction);
  }
}
```

The Scenario Runner will call `runtime.registerMock()` for each item in the `setup.mocks` array before the `run` block is executed. This provides a clean, centralized way to inject test-specific behavior.

---

## 5. Evaluator Reference

Each evaluation is a class that implements a simple `Evaluator` interface.

```typescript
// in packages/cli/src/scenarios/evaluators/types.ts
interface EvaluationResult {
  success: boolean;
  message: string;
}

interface Evaluator {
  type: string;
  evaluate(params: any, result: ExecutionResult): Promise<EvaluationResult>;
}
```

**Initial Set of Evaluators:**

| Type                         | Description                                                                            | Parameters                 |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------- |
| `string_contains`            | Checks if the agent's final response contains a given substring.                       | `value`, `case_sensitive`  |
| `regex_match`                | Checks if the agent's final response matches a regular expression.                     | `pattern`                  |
| `file_exists`                | Checks if a file exists in the execution environment at a given path.                  | `path`                     |
| `file_contains`              | Checks if a file's content contains a given substring.                                 | `path`, `value`            |
| `command_exit_code_is`       | Checks the exit code of a command run inside the environment.                          | `command`, `expected_code` |
| `trajectory_contains_action` | Checks the agent's internal event log to see if a specific action was executed.        | `action`                   |
| `llm_judge`                  | Asks an LLM to judge the agent's response based on a given prompt and expected answer. | `prompt`, `expected`       |
