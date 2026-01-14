import { AgentRuntime, ChannelType, createMessageMemory, stringToUuid } from "@elizaos/core";
import { elizaClassicPlugin } from "@elizaos/plugin-eliza-classic";
import { plugin as inmemorydbPlugin } from "@elizaos/plugin-inmemorydb";
import mcpPlugin from "@elizaos/plugin-mcp";
import { describe, expect, test, vi } from "vitest";
import { COMPUTERUSE_SERVICE_TYPE } from "../src/service-registry.js";
import type { ComputerUseService } from "../src/services/computeruse-service.js";

const ROOM_ID = stringToUuid("computeruse-test-room");
const USER_ID = stringToUuid("computeruse-test-user");

describe("@elizaos/plugin-computeruse", () => {
  test("does not block runtime init when COMPUTERUSE is disabled", async () => {
    process.env.COMPUTERUSE_ENABLED = "false";
    process.env.COMPUTERUSE_MODE = "auto";

    vi.resetModules();
    const { default: computerusePlugin } = await import("../src/index.js");

    const runtime = new AgentRuntime({
      character: {
        name: "TestAgent",
        system: "You are a test agent.",
        settings: {
          // no MCP servers needed for this test
        },
      },
      plugins: [inmemorydbPlugin, mcpPlugin, elizaClassicPlugin, computerusePlugin],
    });

    await runtime.initialize();

    const msg = createMessageMemory({
      id: stringToUuid("msg-1"),
      entityId: USER_ID,
      roomId: ROOM_ID,
      content: { text: "click the button", source: "test", channelType: ChannelType.DM },
    });

    // With COMPUTERUSE disabled, action should not validate.
    const action = runtime.actions.find((a) => a.name === "COMPUTERUSE_CLICK");
    expect(action).toBeTruthy();
    const canRun = await action?.validate(runtime, msg);
    expect(canRun).toBe(false);

    await runtime.stop();
  });

  test("can initialize in MCP mode when server is configured (even if unreachable)", async () => {
    process.env.COMPUTERUSE_ENABLED = "true";
    process.env.COMPUTERUSE_MODE = "mcp";
    process.env.COMPUTERUSE_MCP_SERVER = "computeruse";

    vi.resetModules();
    const { default: computerusePlugin } = await import("../src/index.js");

    const runtime = new AgentRuntime({
      character: {
        name: "TestAgent",
        system: "You are a test agent.",
        settings: {
          mcp: {
            servers: {
              // Intentionally unreachable; initialization should still succeed (best-effort connect).
              computeruse: {
                type: "streamable-http",
                url: "http://127.0.0.1:9/mcp",
                timeout: 1,
              },
            },
          },
        },
      },
      plugins: [inmemorydbPlugin, mcpPlugin, elizaClassicPlugin, computerusePlugin],
    });

    await runtime.initialize();

    await runtime.getServiceLoadPromise(COMPUTERUSE_SERVICE_TYPE);
    const svc = runtime.getService<ComputerUseService>(COMPUTERUSE_SERVICE_TYPE);
    // Helpful debugging signal if this ever regresses.
    expect(svc).toBeTruthy();
    expect(svc?.isEnabled()).toBe(true);

    const msg = createMessageMemory({
      id: stringToUuid("msg-2"),
      entityId: USER_ID,
      roomId: ROOM_ID,
      content: { text: "open calc", source: "test", channelType: ChannelType.DM },
    });

    // Validation is keyword-based; should pass for "open".
    const action = runtime.actions.find((a) => a.name === "COMPUTERUSE_OPEN_APPLICATION");
    expect(action).toBeTruthy();
    const canRun = await action?.validate(runtime, msg);
    expect(canRun).toBe(true);

    // Handler will fail because MCP server is unreachable, but should fail gracefully.
    const result = await action?.handler(
      runtime,
      msg,
      undefined,
      { parameters: { name: "calc" } },
      undefined,
      undefined
    );
    expect(result?.success).toBe(false);

    await runtime.stop();
  });

  test("in MCP mode, click requires process (or process: prefix)", async () => {
    process.env.COMPUTERUSE_ENABLED = "true";
    process.env.COMPUTERUSE_MODE = "mcp";
    process.env.COMPUTERUSE_MCP_SERVER = "computeruse";

    vi.resetModules();
    const { default: computerusePlugin } = await import("../src/index.js");

    const runtime = new AgentRuntime({
      character: {
        name: "TestAgent",
        system: "You are a test agent.",
        settings: {
          mcp: {
            servers: {
              computeruse: {
                type: "streamable-http",
                url: "http://127.0.0.1:9/mcp",
                timeout: 1,
              },
            },
          },
        },
      },
      plugins: [inmemorydbPlugin, mcpPlugin, elizaClassicPlugin, computerusePlugin],
    });
    await runtime.initialize();
    await runtime.getServiceLoadPromise(COMPUTERUSE_SERVICE_TYPE);

    const msg = createMessageMemory({
      id: stringToUuid("msg-3"),
      entityId: USER_ID,
      roomId: ROOM_ID,
      content: { text: "click save", source: "test", channelType: ChannelType.DM },
    });

    const action = runtime.actions.find((a) => a.name === "COMPUTERUSE_CLICK");
    expect(action).toBeTruthy();

    const resultMissingProcess = await action?.handler(
      runtime,
      msg,
      undefined,
      { parameters: { selector: "role:Button|name:Save" } },
      undefined,
      undefined
    );
    expect(resultMissingProcess?.success).toBe(false);
    expect(resultMissingProcess?.text).toContain("Missing process");

    const resultWithProcessPrefix = await action?.handler(
      runtime,
      msg,
      undefined,
      { parameters: { selector: "process:notepad >> role:Button|name:Save" } },
      undefined,
      undefined
    );
    expect(resultWithProcessPrefix?.success).toBe(false);
    expect(resultWithProcessPrefix?.text).not.toContain("Missing process");

    await runtime.stop();
  });

  test("COMPUTERUSE_GET_WINDOW_TREE is registered and fails gracefully when MCP is unreachable", async () => {
    process.env.COMPUTERUSE_ENABLED = "true";
    process.env.COMPUTERUSE_MODE = "mcp";
    process.env.COMPUTERUSE_MCP_SERVER = "computeruse";

    vi.resetModules();
    const { default: computerusePlugin } = await import("../src/index.js");

    const runtime = new AgentRuntime({
      character: {
        name: "TestAgent",
        system: "You are a test agent.",
        settings: {
          mcp: {
            servers: {
              computeruse: {
                type: "streamable-http",
                url: "http://127.0.0.1:9/mcp",
                timeout: 1,
              },
            },
          },
        },
      },
      plugins: [inmemorydbPlugin, mcpPlugin, elizaClassicPlugin, computerusePlugin],
    });
    await runtime.initialize();
    await runtime.getServiceLoadPromise(COMPUTERUSE_SERVICE_TYPE);

    const action = runtime.actions.find((a) => a.name === "COMPUTERUSE_GET_WINDOW_TREE");
    expect(action).toBeTruthy();

    const msg = createMessageMemory({
      id: stringToUuid("msg-4"),
      entityId: USER_ID,
      roomId: ROOM_ID,
      content: { text: "get ui tree", source: "test", channelType: ChannelType.DM },
    });

    const result = await action?.handler(
      runtime,
      msg,
      undefined,
      { parameters: { process: "notepad", maxDepth: 3 } },
      undefined,
      undefined
    );
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("get window tree failed");

    await runtime.stop();
  });
});
