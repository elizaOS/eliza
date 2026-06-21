/**
 * Real-runtime integration test for the slash-command shortcut path
 * (#8790 × #8791). Builds an actual AgentRuntime, registers the real
 * `@elizaos/plugin-commands`, and drives the real pre-LLM gate — proving that
 * `registerPlugin` wires `Plugin.shortcuts` into the runtime registry and that a
 * slash command resolves to a deterministic reply with no model call.
 */
import {
  AgentRuntime,
  type Character,
  InMemoryDatabaseAdapter,
  type Memory,
  runShortcutGate,
  type State,
  type UUID,
} from "@elizaos/core";
import commandsPlugin from "@elizaos/plugin-commands";
import { beforeAll, describe, expect, it } from "vitest";

const responseId = "00000000-0000-0000-0000-0000000000f1" as UUID;

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000b2" as UUID,
    entityId: "00000000-0000-0000-0000-0000000000c2" as UUID,
    roomId: "00000000-0000-0000-0000-0000000000d2" as UUID,
    content: { text, source: "client_chat" },
  } as unknown as Memory;
}

describe("commands plugin → runtime shortcut wiring (real runtime)", () => {
  let runtime: AgentRuntime;

  beforeAll(async () => {
    runtime = new AgentRuntime({
      character: { name: "TestAgent", bio: ["t"], settings: {} } as Character,
      adapter: new InMemoryDatabaseAdapter(),
      logLevel: "fatal",
    });
    runtime.composeState = async () => ({ values: {}, data: {}, text: "" });
    await runtime.registerPlugin(commandsPlugin);
  });

  it("registers the command actions and slash shortcuts", () => {
    expect(
      runtime.actions.find((a) => a.name === "HELP_COMMAND"),
    ).toBeDefined();
    expect(
      runtime.actions.find((a) => a.name === "STATUS_COMMAND"),
    ).toBeDefined();
    expect(runtime.shortcutRegistry.size).toBeGreaterThan(0);
    const match = runtime.shortcutRegistry.match("/help");
    expect(match?.shortcut.target).toMatchObject({
      kind: "action",
      name: "HELP_COMMAND",
    });
  });

  it("resolves /help deterministically through the real gate (no model)", async () => {
    const result = await runShortcutGate({
      runtime,
      message: message("/help"),
      state: {} as State,
      responseId,
      senderRole: "OWNER",
    });
    expect(result?.kind).toBe("direct_reply");
    if (result?.kind !== "direct_reply")
      throw new Error("expected direct_reply");
    expect(result.result.responseContent?.text).toContain("Available commands");
  });

  it("resolves /status through the real gate", async () => {
    const result = await runShortcutGate({
      runtime,
      message: message("/status"),
      state: {} as State,
      responseId,
      senderRole: "OWNER",
    });
    expect(result?.kind).toBe("direct_reply");
    if (result?.kind !== "direct_reply")
      throw new Error("expected direct_reply");
    expect(result.result.responseContent?.text).toContain("Agent: TestAgent");
  });

  it("does not fire the gate for a plain message", async () => {
    const result = await runShortcutGate({
      runtime,
      message: message("what's the weather like?"),
      state: {} as State,
      responseId,
      senderRole: "OWNER",
    });
    expect(result).toBeNull();
  });
});
