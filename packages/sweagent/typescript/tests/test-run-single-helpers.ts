/**
 * Helper classes for test-run-single.test.ts
 */

import {
  AbstractDeployment,
  AbstractRuntime,
  type BashAction,
  type BashActionResult,
  type BashInterruptAction,
  type Command,
  type CommandResult,
  type CreateBashSessionRequest,
  type ReadFileRequest,
  type ReadFileResponse,
  type UploadRequest,
  type WriteFileRequest,
} from "../src/environment/deployment";

/**
 * Mock runtime for testing
 */
export class MockRuntime extends AbstractRuntime {
  private files: Map<string, string> = new Map();
  private sessionOutput: string = "";

  async createSession(_request: CreateBashSessionRequest): Promise<void> {
    // Reset per-session state.
    this.sessionOutput = "";
  }

  async runInSession(
    action: BashAction | BashInterruptAction,
  ): Promise<BashActionResult> {
    if ("type" in action && action.type === "interrupt") {
      return { output: "", exitCode: 0 };
    }

    const bashAction = action as BashAction;
    const cmd = bashAction.command.trim();

    // Mock some basic commands
    if (cmd.startsWith("echo ")) {
      const text = cmd.substring(5).replace(/['"]/g, "");
      return { output: `${text}\n`, exitCode: 0 };
    }

    if (cmd === "ls") {
      return { output: "file1\nfile2\n", exitCode: 0 };
    }

    if (cmd.startsWith("sleep ")) {
      const seconds = Number.parseFloat(cmd.substring(6));
      if (bashAction.timeout && bashAction.timeout < seconds) {
        throw new Error("Command timeout");
      }
      return { output: "", exitCode: 0 };
    }

    // SWE-agent submission: create model.patch and emit the submission marker.
    if (cmd === "submit" || cmd.startsWith("submit ")) {
      const patch =
        "diff --git a/placeholder.txt b/placeholder.txt\n" +
        "new file mode 100644\n" +
        "index 0000000..e69de29\n" +
        "--- /dev/null\n" +
        "+++ b/placeholder.txt\n" +
        "@@\n";
      this.files.set("/root/model.patch", patch);
      return { output: "<<SWE_AGENT_SUBMISSION>>\n", exitCode: 0 };
    }

    return { output: this.sessionOutput, exitCode: 0 };
  }

  async execute(_command: Command): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async readFile(request: ReadFileRequest): Promise<ReadFileResponse> {
    const content = this.files.get(request.path) || "";
    return { content };
  }

  async writeFile(request: WriteFileRequest): Promise<void> {
    this.files.set(request.path, request.content);
  }

  async upload(_request: UploadRequest): Promise<void> {
    // Mock implementation
  }
}

/**
 * Mock deployment for testing
 */
export class MockDeployment extends AbstractDeployment {
  runtime: MockRuntime;

  constructor() {
    super();
    this.runtime = new MockRuntime();
  }

  async start(): Promise<void> {
    // Mock implementation
  }

  async stop(): Promise<void> {
    // Mock implementation
  }
}
