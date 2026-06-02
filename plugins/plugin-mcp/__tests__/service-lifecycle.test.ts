import { describe, expect, it, vi } from "vitest";
import { McpService } from "../src/service";

describe("McpService lifecycle", () => {
  it("cleans connection state even when transport close fails", async () => {
    const service = new McpService();
    const internals = service as unknown as {
      connections: Map<
        string,
        {
          transport: { close: ReturnType<typeof vi.fn> };
          client: { close: ReturnType<typeof vi.fn> };
        }
      >;
      connectionStates: Map<
        string,
        {
          pingInterval?: ReturnType<typeof setInterval>;
          reconnectTimeout?: ReturnType<typeof setTimeout>;
        }
      >;
    };
    const pingInterval = setInterval(() => {}, 10_000);
    const reconnectTimeout = setTimeout(() => {}, 10_000);
    const clientClose = vi.fn(async () => {});

    internals.connections.set("bad-close", {
      transport: { close: vi.fn(async () => Promise.reject(new Error("close failed"))) },
      client: { close: clientClose },
    });
    internals.connectionStates.set("bad-close", {
      pingInterval,
      reconnectTimeout,
    });

    await expect(service.deleteConnection("bad-close")).resolves.toBeUndefined();

    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(internals.connections.has("bad-close")).toBe(false);
    expect(internals.connectionStates.has("bad-close")).toBe(false);
  });
});
