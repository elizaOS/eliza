/**
 * Tests for the RLM IPC server module.
 */

import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { RLMClient } from "../client";
import type { RLMServerResponse } from "../server";
import { createRLMServer, RLMServer } from "../server";

// ============================================================================
// Helpers
// ============================================================================

/** Create a client in stub mode (Python not available). */
function createStubClient(): RLMClient {
  return new RLMClient({ pythonPath: "/nonexistent/python" });
}

/**
 * Connect to a TCP server and provide send/receive helpers.
 * Returns a promise-based interface for testing.
 */
function connectToServer(port: number): Promise<{
  send: (data: object) => void;
  receive: () => Promise<RLMServerResponse>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, "127.0.0.1", () => {
      let buffer = "";
      const pendingResolvers: Array<(value: RLMServerResponse) => void> = [];
      const receivedMessages: RLMServerResponse[] = [];

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            const msg = JSON.parse(line) as RLMServerResponse;
            const resolver = pendingResolvers.shift();
            if (resolver) {
              resolver(msg);
            } else {
              receivedMessages.push(msg);
            }
          }
        }
      });

      resolve({
        send: (data: object) => {
          socket.write(`${JSON.stringify(data)}\n`);
        },
        receive: () => {
          const queued = receivedMessages.shift();
          if (queued) return Promise.resolve(queued);

          return new Promise<RLMServerResponse>((res, rej) => {
            const timeout = setTimeout(() => {
              rej(new Error("Receive timeout"));
            }, 5000);
            pendingResolvers.push((value) => {
              clearTimeout(timeout);
              res(value);
            });
          });
        },
        close: () => {
          socket.destroy();
        },
      });
    });

    socket.on("error", reject);
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("RLMServer", () => {
  let server: RLMServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  // --------------------------------------------------------------------------
  // Construction & Lifecycle
  // --------------------------------------------------------------------------

  describe("Construction", () => {
    it("should create a server with createRLMServer", () => {
      const client = createStubClient();
      server = createRLMServer(client);
      expect(server).toBeInstanceOf(RLMServer);
      expect(server.running).toBe(false);
      expect(server.port).toBe(0);
    });

    it("should create a server with new RLMServer", () => {
      const client = createStubClient();
      server = new RLMServer(client);
      expect(server.running).toBe(false);
    });

    it("should accept options", () => {
      const client = createStubClient();
      server = createRLMServer(client, {
        host: "127.0.0.1",
        onError: () => {},
      });
      expect(server).toBeInstanceOf(RLMServer);
    });
  });

  describe("Start / Stop", () => {
    it("should start on a random port", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      expect(server.running).toBe(true);
      expect(server.port).toBeGreaterThan(0);
    });

    it("should stop cleanly", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);
      expect(server.running).toBe(true);

      await server.stop();
      expect(server.running).toBe(false);
      expect(server.port).toBe(0);
    });

    it("should be idempotent on start", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);
      const port = server.port;

      // Calling start again should be a no-op
      await server.start(0);
      expect(server.port).toBe(port);
    });

    it("should be idempotent on stop", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      // Stop without starting
      await server.stop();
      expect(server.running).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Request handling
  // --------------------------------------------------------------------------

  describe("Status Request", () => {
    it("should return status response", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      const conn = await connectToServer(server.port);
      try {
        conn.send({ id: 1, type: "status" });
        const response = await conn.receive();

        expect(response.id).toBe(1);
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();

        const result = response.result as Record<string, unknown>;
        expect(result).toHaveProperty("available");
        expect(result).toHaveProperty("backend");
        expect(result).toHaveProperty("environment");
      } finally {
        conn.close();
      }
    });
  });

  describe("Infer Request", () => {
    it("should return infer response (stub mode)", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      const conn = await connectToServer(server.port);
      try {
        conn.send({
          id: 2,
          type: "infer",
          params: { prompt: "Hello, world!" },
        });
        const response = await conn.receive();

        expect(response.id).toBe(2);
        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();

        const result = response.result as Record<string, unknown>;
        expect(result).toHaveProperty("text");
        expect(result).toHaveProperty("metadata");
      } finally {
        conn.close();
      }
    });
  });

  describe("Shutdown Request", () => {
    it("should acknowledge shutdown", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      const conn = await connectToServer(server.port);
      try {
        conn.send({ id: 3, type: "shutdown" });
        const response = await conn.receive();

        expect(response.id).toBe(3);
        expect(response.error).toBeUndefined();
        expect(response.result).toEqual({ shutdown: true });
      } finally {
        conn.close();
      }

      // Wait for shutdown to process
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  });

  describe("Error Handling", () => {
    it("should return error for unknown request type", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      const conn = await connectToServer(server.port);
      try {
        conn.send({ id: 4, type: "unknown_type" });
        const response = await conn.receive();

        expect(response.id).toBe(4);
        expect(response.error).toBeDefined();
        expect(response.error).toContain("Unknown request type");
      } finally {
        conn.close();
      }
    });

    it("should handle invalid JSON gracefully", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      // Connect raw socket
      await new Promise<void>((resolve) => {
        const socket = net.createConnection(server?.port, "127.0.0.1", () => {
          socket.write("not valid json\n");

          let data = "";
          socket.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes("\n")) {
              const response = JSON.parse(data.trim()) as RLMServerResponse;
              expect(response.error).toBeDefined();
              expect(response.error).toContain("Invalid request");
              socket.destroy();
              resolve();
            }
          });
        });
      });
    });
  });

  // --------------------------------------------------------------------------
  // Connection tracking
  // --------------------------------------------------------------------------

  describe("Connection Tracking", () => {
    it("should track connection count", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      expect(server.connectionCount).toBe(0);

      const conn1 = await connectToServer(server.port);
      // Give time for connection to register
      await new Promise((r) => setTimeout(r, 50));
      expect(server.connectionCount).toBe(1);

      const conn2 = await connectToServer(server.port);
      await new Promise((r) => setTimeout(r, 50));
      expect(server.connectionCount).toBe(2);

      conn1.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(server.connectionCount).toBe(1);

      conn2.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(server.connectionCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Multiple requests on same connection
  // --------------------------------------------------------------------------

  describe("Multiple Requests", () => {
    it("should handle multiple sequential requests", async () => {
      const client = createStubClient();
      server = createRLMServer(client);
      await server.start(0);

      const conn = await connectToServer(server.port);
      try {
        // First request
        conn.send({ id: 10, type: "status" });
        const r1 = await conn.receive();
        expect(r1.id).toBe(10);
        expect(r1.error).toBeUndefined();

        // Second request
        conn.send({ id: 11, type: "infer", params: { prompt: "test" } });
        const r2 = await conn.receive();
        expect(r2.id).toBe(11);
        expect(r2.error).toBeUndefined();
      } finally {
        conn.close();
      }
    });
  });
});
