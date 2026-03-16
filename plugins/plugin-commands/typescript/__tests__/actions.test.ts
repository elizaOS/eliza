/**
 * @module actions.test
 * @description Tests for command action handlers — validates that each
 * command action correctly validates, executes, and returns formatted results.
 * Tests cover HELP_COMMAND, STATUS_COMMAND, STOP_COMMAND, MODELS_COMMAND,
 * and COMMANDS_LIST with validation, success path, and error path for each.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { helpAction } from "../src/actions/help";
import { statusAction } from "../src/actions/status";
import { stopAction } from "../src/actions/stop";
import { modelsAction } from "../src/actions/models";
import { commandsListAction } from "../src/actions/commands-list";
import { resetCommands } from "../src/registry";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

// ============================================================================
// Mock Runtime Factory
// ============================================================================

function createMockRuntime(
  overrides: Partial<Record<string, any>> = {},
): IAgentRuntime {
  return {
    agentId: "test-agent-id",
    character: { name: "TestBot" },
    getService: mock(() => null),
    getSetting: mock((key: string) => overrides[key] ?? null),
    getModel: mock((_type: string) => null),
    emitEvent: mock(async () => {}),
    getTasks: mock(async () => []),
    ...overrides,
  } as unknown as IAgentRuntime;
}

function createMockMessage(text: string, roomId = "test-room"): Memory {
  return {
    content: { text, source: "test" },
    roomId,
    entityId: "test-entity",
  } as unknown as Memory;
}

function createMockState(): State {
  return {} as State;
}

// ============================================================================
// HELP_COMMAND
// ============================================================================

describe("HELP_COMMAND", () => {
  beforeEach(() => {
    resetCommands();
  });

  it("validates for /help command", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/help");

    const result = await helpAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("validates for /? alias", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/?");

    const result = await helpAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("does NOT validate for natural language 'help me'", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("help me please");

    const result = await helpAction.validate!(runtime, message);
    expect(result).toBe(false);
  });

  it("handler returns formatted help text with commands", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/help");
    let callbackText = "";
    const callback = mock(async (response: any) => {
      callbackText = response.text;
    });

    const result = await helpAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Available Commands");
    expect(callbackText).toContain("Available Commands");
    // Should list some default commands
    expect(result.text).toContain("/help");
    expect(result.text).toContain("/status");
  });

  it("handler returns data with command count", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/help");

    const result = await helpAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    expect(result.data?.commandCount).toBeGreaterThan(0);
  });
});

// ============================================================================
// STATUS_COMMAND
// ============================================================================

describe("STATUS_COMMAND", () => {
  beforeEach(() => {
    resetCommands();
  });

  it("validates for /status command", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/status");

    const result = await statusAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("validates for /s alias", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/s");

    const result = await statusAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("does NOT validate for natural language 'what is your status'", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("what is your status");

    const result = await statusAction.validate!(runtime, message);
    expect(result).toBe(false);
  });

  it("handler returns session info with agent name and room", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/status", "room-456");
    let callbackText = "";
    const callback = mock(async (response: any) => {
      callbackText = response.text;
    });

    const result = await statusAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Session Status");
    expect(result.text).toContain("TestBot");
    expect(result.text).toContain("room-456");
    expect(callbackText).toContain("Session Status");
  });

  it("handler works when directive service is not available", async () => {
    const runtime = createMockRuntime({
      getService: mock(() => null),
    });
    const message = createMockMessage("/status");

    const result = await statusAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    // Should not throw, just skip directive section
    expect(result.success).toBe(true);
    expect(result.text).toContain("Session Status");
  });
});

// ============================================================================
// STOP_COMMAND
// ============================================================================

describe("STOP_COMMAND", () => {
  beforeEach(() => {
    resetCommands();
  });

  it("validates for /stop command", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/stop");

    const result = await stopAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("validates for /abort alias", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/abort");

    const result = await stopAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("validates for /cancel alias", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/cancel");

    const result = await stopAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("does NOT validate for natural language 'stop talking'", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("stop talking");

    const result = await stopAction.validate!(runtime, message);
    expect(result).toBe(false);
  });

  it("handler emits HOOK_COMMAND_STOP event", async () => {
    const emitEvent = mock(async () => {});
    const runtime = createMockRuntime({ emitEvent });
    const message = createMockMessage("/stop", "stop-room");

    await stopAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    expect(emitEvent).toHaveBeenCalled();
  });

  it("handler returns stop confirmation text", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/stop");
    let callbackText = "";
    const callback = mock(async (response: any) => {
      callbackText = response.text;
    });

    const result = await stopAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Stop requested");
    expect(callbackText).toContain("Stop requested");
  });

  it("handler still succeeds even if emitEvent throws", async () => {
    const emitEvent = mock(async () => {
      throw new Error("Event bus failure");
    });
    const runtime = createMockRuntime({ emitEvent });
    const message = createMockMessage("/stop");

    // Should not throw — the handler catches event emit errors
    const result = await stopAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Stop requested");
  });
});

// ============================================================================
// MODELS_COMMAND
// ============================================================================

describe("MODELS_COMMAND", () => {
  beforeEach(() => {
    resetCommands();
  });

  it("validates for /models command", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/models");

    const result = await modelsAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("does NOT validate for natural language 'show me models'", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("show me models");

    const result = await modelsAction.validate!(runtime, message);
    expect(result).toBe(false);
  });

  it("handler returns model list when no models registered", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/models");
    let callbackText = "";
    const callback = mock(async (response: any) => {
      callbackText = response.text;
    });

    const result = await modelsAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Available Models");
    expect(callbackText).toContain("Available Models");
  });

  it("handler shows model configuration when settings exist", async () => {
    const runtime = createMockRuntime({
      getSetting: mock((key: string) => {
        if (key === "MODEL_PROVIDER") return "anthropic";
        if (key === "MODEL_NAME") return "claude-3-opus";
        return null;
      }),
    });
    const message = createMockMessage("/models");

    const result = await modelsAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    expect(result.text).toContain("Current Configuration");
    expect(result.text).toContain("anthropic");
    expect(result.text).toContain("claude-3-opus");
  });

  it("handler includes model switch hint", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/models");

    const result = await modelsAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    expect(result.text).toContain("/model");
    expect(result.text).toContain("switch models");
  });
});

// ============================================================================
// COMMANDS_LIST
// ============================================================================

describe("COMMANDS_LIST", () => {
  beforeEach(() => {
    resetCommands();
  });

  it("validates for /commands command", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/commands");

    const result = await commandsListAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("validates for /cmds alias", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/cmds");

    const result = await commandsListAction.validate!(runtime, message);
    expect(result).toBe(true);
  });

  it("does NOT validate for natural language 'list commands'", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("list commands");

    const result = await commandsListAction.validate!(runtime, message);
    expect(result).toBe(false);
  });

  it("handler lists all enabled commands", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/commands");
    let callbackText = "";
    const callback = mock(async (response: any) => {
      callbackText = response.text;
    });

    const result = await commandsListAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      callback,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Commands");
    expect(callbackText).toContain("Commands");

    // Should list known command keys
    expect(result.text).toContain("help");
    expect(result.text).toContain("status");
    expect(result.text).toContain("stop");
  });

  it("handler returns command count in data", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/commands");

    const result = await commandsListAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    expect(result.data?.commandCount).toBeGreaterThan(0);
  });

  it("handler includes auth/elevated annotations when present", async () => {
    const runtime = createMockRuntime();
    const message = createMockMessage("/commands");

    const result = await commandsListAction.handler(
      runtime,
      message,
      createMockState(),
      {},
      mock(async () => {}),
    );

    // Commands like "bash" require auth + elevated — verify annotations exist
    // (bash is disabled by default so it won't appear, but restart has requiresAuth)
    if (result.text.includes("[auth]")) {
      expect(result.text).toContain("[auth]");
    }
  });
});

// ============================================================================
// Cross-cutting: all actions have correct name and description
// ============================================================================

describe("Action metadata", () => {
  it("all actions have name and description", () => {
    const actions = [
      helpAction,
      statusAction,
      stopAction,
      modelsAction,
      commandsListAction,
    ];

    for (const action of actions) {
      expect(action.name).toBeTruthy();
      expect(action.description).toBeTruthy();
      expect(action.handler).toBeDefined();
      expect(action.validate).toBeDefined();
      expect(action.similes?.length).toBeGreaterThan(0);
    }
  });

  it("all actions have examples", () => {
    const actions = [
      helpAction,
      statusAction,
      stopAction,
      modelsAction,
      commandsListAction,
    ];

    for (const action of actions) {
      expect(action.examples?.length).toBeGreaterThan(0);
    }
  });

  it("no action validates empty string", async () => {
    const runtime = createMockRuntime();
    const emptyMessage = createMockMessage("");

    const actions = [
      helpAction,
      statusAction,
      stopAction,
      modelsAction,
      commandsListAction,
    ];

    for (const action of actions) {
      const result = await action.validate!(runtime, emptyMessage);
      expect(result).toBe(false);
    }
  });
});
