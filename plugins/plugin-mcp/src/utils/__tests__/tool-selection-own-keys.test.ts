/**
 * A server may advertise a server or tool whose literal name is `__proto__`.
 * The projection must store that name as an own key, and the selection path
 * must accept the advertised name while still rejecting inherited
 * Object.prototype names the model made up.
 */
import { describe, expect, it, vi } from "vitest";
import { buildMcpProviderProjection } from "../../protocol-utils/provider-projection";
import { createToolSelectionArgument } from "../selection";
import { validateToolSelectionName } from "../validation";

const reserved = "__proto__";

const advertisedServer = {
  name: reserved,
  status: "connected",
  tools: [
    {
      name: reserved,
      description: "a tool the server really lists",
      inputSchema: { type: "object" },
    },
  ],
  resources: [{ uri: reserved, name: "a resource the server really lists" }],
};

/** Only the runtime calls the selection path makes: settings and one model call. */
function stubRuntime(reply = JSON.stringify({ toolArguments: { target: "today" } })) {
  return {
    getSetting: () => ({ servers: {}, maxRetries: 0 }),
    useModel: vi.fn(async () => reply),
  };
}

function stateOf(projection: ReturnType<typeof buildMcpProviderProjection>) {
  return {
    values: { mcp: projection.values.mcp, mcpText: projection.values.mcpText },
    data: {},
    text: "",
  } as never;
}

const message = { content: { text: "add the reminder for today" } } as never;

describe("MCP tool selection with a server-supplied __proto__ name", () => {
  it("stores the advertised server and tool as own keys", () => {
    const projection = buildMcpProviderProjection([advertisedServer]);
    const servers = projection.data.mcp as Record<string, { tools: object }>;

    expect(Object.getPrototypeOf(servers)).toBeNull();
    expect(Object.hasOwn(servers, reserved)).toBe(true);
    expect(servers[reserved].tools).toBeDefined();
    expect(Object.hasOwn(servers[reserved].tools, reserved)).toBe(true);
    expect(Object.hasOwn(projection.values.mcp, reserved)).toBe(true);
  });

  it("accepts the advertised name in validation", () => {
    const projection = buildMcpProviderProjection([advertisedServer]);

    expect(
      validateToolSelectionName({ serverName: reserved, toolName: reserved }, stateOf(projection))
    ).toEqual({
      success: true,
      data: { serverName: reserved, toolName: reserved },
    });
  });

  it("resolves the advertised name in argument creation", async () => {
    const projection = buildMcpProviderProjection([advertisedServer]);
    const runtime = stubRuntime();

    // A name without an own key throws before the model is asked, so one model
    // call proves that both lookups resolved the advertised `__proto__` entry.
    // The argument value itself is decided by the sandboxed schema worker, which
    // runs on its own time budget, so this test does not assert the value.
    await createToolSelectionArgument({
      runtime: runtime as never,
      state: stateOf(projection),
      message,
      mcpProvider: projection as never,
      toolSelectionName: { serverName: reserved, toolName: reserved },
    });

    expect(runtime.useModel).toHaveBeenCalledTimes(1);
  });

  it("rejects an inherited name before it asks the model", async () => {
    const projection = buildMcpProviderProjection([advertisedServer]);
    const runtime = stubRuntime();

    await expect(
      createToolSelectionArgument({
        runtime: runtime as never,
        state: stateOf(projection),
        message,
        mcpProvider: projection as never,
        toolSelectionName: { serverName: "constructor", toolName: reserved },
      })
    ).rejects.toThrow('Server "constructor" not found in MCP provider data');

    await expect(
      createToolSelectionArgument({
        runtime: runtime as never,
        state: stateOf(projection),
        message,
        mcpProvider: projection as never,
        toolSelectionName: { serverName: reserved, toolName: "toString" },
      })
    ).rejects.toThrow(`Tool "toString" not found on server "${reserved}"`);

    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("still rejects inherited names the server did not list", () => {
    const projection = buildMcpProviderProjection([advertisedServer]);
    const state = stateOf(projection);

    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      expect(validateToolSelectionName({ serverName: name, toolName: reserved }, state)).toEqual({
        success: false,
        error: `Server "${name}" not found or not connected`,
      });
      expect(validateToolSelectionName({ serverName: reserved, toolName: name }, state)).toEqual({
        success: false,
        error: `Tool "${name}" not found on server "${reserved}"`,
      });
    }
  });
});
