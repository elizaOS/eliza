/**
 * Tests McpService teardown: connections and connection state are cleaned up even
 * when a transport/client close rejects. Uses stubbed transport/client doubles.
 */
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

  it("does not delete a replacement while the old transport is closing", async () => {
    const service = new McpService();
    const internals = service as unknown as {
      connections: Map<string, object>;
      connectionStates: Map<string, object>;
    };
    const closing = Promise.withResolvers<void>();
    internals.connections.set("pages", {
      transport: { close: () => closing.promise },
      client: { close: vi.fn(async () => {}) },
    });
    internals.connectionStates.set("pages", {});
    const deletion = service.deleteConnection("pages");
    const replacement = { server: { status: "connecting" } };
    const replacementState = { reconnectAttempts: 2 };
    internals.connections.set("pages", replacement);
    internals.connectionStates.set("pages", replacementState);
    closing.resolve();
    await deletion;
    expect(internals.connections.get("pages")).toBe(replacement);
    expect(internals.connectionStates.get("pages")).toBe(replacementState);
  });

  it("handles corrupted config JSON in restartConnection by setting error status without throwing", async () => {
    const service = new McpService();
    const internals = service as unknown as {
      connections: Map<
        string,
        {
          server: { status: string; error?: string; config: string };
        }
      >;
    };

    internals.connections.set("corrupted-server", {
      server: {
        status: "idle",
        config: "{ invalid json payload, unclosed",
      },
    });

    await expect(service.restartConnection("corrupted-server")).resolves.toBeUndefined();

    const connection = internals.connections.get("corrupted-server");
    expect(connection?.server.status).toBe("error");
    expect(connection?.server.error).toContain("Invalid server configuration JSON");
  });
});
