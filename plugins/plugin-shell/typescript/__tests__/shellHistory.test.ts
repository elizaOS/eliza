import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellService } from "../services/shellService";

vi.mock("../utils/config", () => ({
  loadShellConfig: () => ({
    enabled: true,
    allowedDirectory: "/test/allowed",
    timeout: 30000,
    forbiddenCommands: ["rm", "rmdir"],
  }),
  DEFAULT_FORBIDDEN_COMMANDS: [],
}));

vi.mock("cross-spawn", () => ({
  default: vi.fn(),
}));

vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    Service: class {
      protected runtime: IAgentRuntime;
      constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
      }
    },
  };
});

/**
 * Creates a mock AgentRuntime for testing.
 */
function createMockRuntime(): IAgentRuntime {
  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: {
      name: "Test Agent",
      bio: ["A test agent for shell operations"],
      system: "You are a helpful assistant.",
      templates: {},
      plugins: [],
      knowledge: [],
      secrets: {},
      settings: {},
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getService: vi.fn(),
    registerService: vi.fn(),
    useModel: vi.fn(),
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("Shell History Tracking", () => {
  let shellService: ShellService;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    runtime = createMockRuntime();
    shellService = new ShellService(runtime);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should track command history per conversation", async () => {
    const conversationId = "test-conversation-1";

    vi.spyOn(shellService as never, "runCommand").mockResolvedValue({
      success: true,
      stdout: "file1.txt\nfile2.txt",
      stderr: "",
      exitCode: 0,
      executedIn: "/test/allowed",
    });

    await shellService.executeCommand("ls", conversationId);
    const history = shellService.getCommandHistory(conversationId);

    expect(history).toHaveLength(1);
    expect(history[0].command).toBe("ls");
    expect(history[0].stdout).toBe("file1.txt\nfile2.txt");
    expect(history[0].exitCode).toBe(0);
    expect(history[0].workingDirectory).toBe("/test/allowed");
  });

  it("should track file operations", async () => {
    const conversationId = "test-conversation-2";

    // Mock the runCommand method
    vi.spyOn(shellService as never, "runCommand").mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      executedIn: "/test/allowed",
    });

    await shellService.executeCommand("touch test.txt", conversationId);
    const history = shellService.getCommandHistory(conversationId);

    expect(history).toHaveLength(1);
    expect(history[0].fileOperations).toBeDefined();
    expect(history[0].fileOperations?.[0]).toEqual({
      type: "create",
      target: "/test/allowed/test.txt",
    });
  });

  it("should clear history for a specific conversation", async () => {
    const conversationId = "test-conversation-3";

    vi.spyOn(shellService as never, "runCommand").mockResolvedValue({
      success: true,
      stdout: "output",
      stderr: "",
      exitCode: 0,
      executedIn: "/test/allowed",
    });

    await shellService.executeCommand("ls", conversationId);
    await shellService.executeCommand("pwd", conversationId);

    let history = shellService.getCommandHistory(conversationId);
    expect(history).toHaveLength(2);

    shellService.clearCommandHistory(conversationId);
    history = shellService.getCommandHistory(conversationId);
    expect(history).toHaveLength(0);
  });

  it("should maintain separate history for different conversations", async () => {
    const conversation1 = "conv-1";
    const conversation2 = "conv-2";

    vi.spyOn(shellService as never, "runCommand").mockResolvedValue({
      success: true,
      stdout: "output",
      stderr: "",
      exitCode: 0,
      executedIn: "/test/allowed",
    });

    await shellService.executeCommand("ls", conversation1);
    await shellService.executeCommand("pwd", conversation2);
    await shellService.executeCommand("echo test", conversation1);

    const history1 = shellService.getCommandHistory(conversation1);
    const history2 = shellService.getCommandHistory(conversation2);

    expect(history1).toHaveLength(2);
    expect(history1[0].command).toBe("ls");
    expect(history1[1].command).toBe("echo test");

    expect(history2).toHaveLength(1);
    expect(history2[0].command).toBe("pwd");
  });

  it("should detect various file operations", async () => {
    const conversationId = "test-file-ops";

    vi.spyOn(shellService as never, "runCommand").mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
      executedIn: "/test/allowed",
    });

    const commands = [
      {
        cmd: "touch newfile.txt",
        expectedOp: { type: "create", target: "/test/allowed/newfile.txt" },
      },
      {
        cmd: 'echo "hello" > output.txt',
        expectedOp: { type: "write", target: "/test/allowed/output.txt" },
      },
      {
        cmd: "mkdir newdir",
        expectedOp: { type: "mkdir", target: "/test/allowed/newdir" },
      },
      {
        cmd: "cat input.txt",
        expectedOp: { type: "read", target: "/test/allowed/input.txt" },
      },
    ];

    for (const { cmd } of commands) {
      await shellService.executeCommand(cmd, conversationId);
    }

    const history = shellService.getCommandHistory(conversationId);

    expect(history).toHaveLength(commands.length);

    commands.forEach((command, index) => {
      expect(history[index].fileOperations?.[0]).toEqual(command.expectedOp);
    });
  });
});
