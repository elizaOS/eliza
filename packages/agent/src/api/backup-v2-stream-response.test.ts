/**
 * Exercises capture-v2 response backpressure with a deterministic writable and
 * the complete request/response boundary through a real Node HTTP server. No
 * storage provider, database, credential, or cloud executor is substituted.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import {
  AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2Request,
  parseAgentBackupCaptureV2Frames,
} from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  type AgentBackupV2CaptureComponentSource,
  AgentBackupV2CaptureError,
} from "../services/agent-backup-v2-capture.ts";
import {
  type AgentBackupV2WritableResponse,
  handleAgentBackupV2SnapshotRequest,
  writeAgentBackupV2StreamResponse,
} from "./backup-v2-stream-response.ts";

const ids = {
  operation: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  activation: "33333333-3333-4333-8333-333333333333",
};
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

function request(agentId = ids.agent): AgentBackupCaptureV2Request {
  return {
    format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    operationId: ids.operation,
    agentId,
    activationGeneration: ids.activation,
    lifecycleRevision: "91",
    deadlineEpochMs: Date.now() + 60_000,
  };
}

class BackpressureResponse
  extends EventEmitter
  implements AgentBackupV2WritableResponse
{
  statusCode = 0;
  headersSent = false;
  writableEnded = false;
  readonly headers = new Map<string, string>();
  readonly writes: Uint8Array[] = [];
  destroyedWith: Error | undefined;
  private shouldBackpressure = true;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.headersSent = true;
    this.writes.push(chunk.slice());
    setImmediate(() => callback?.());
    if (this.shouldBackpressure) {
      this.shouldBackpressure = false;
      return false;
    }
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }

  destroy(error?: Error): void {
    this.destroyedWith = error;
    this.emit("close");
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function source(): AgentBackupV2CaptureComponentSource {
  return {
    descriptor: {
      name: "database",
      format: "synthetic-v1",
      compression: "none",
      contentKind: "opaque",
      consistency: "transactional",
    },
    async *open() {
      yield { bytes: new TextEncoder().encode("database-state") };
    },
  };
}

async function listen(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>,
): Promise<number> {
  const server = http.createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return address.port;
}

async function* responseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

describe("writeAgentBackupV2StreamResponse", () => {
  it("does not pull the next frame until the response drains", async () => {
    const response = new BackpressureResponse();
    let pulls = 0;
    async function* frames(): AsyncGenerator<Uint8Array> {
      pulls += 1;
      yield Uint8Array.of(1);
      pulls += 1;
      yield Uint8Array.of(2);
    }

    const writing = writeAgentBackupV2StreamResponse(response, frames());
    await nextTurn();
    expect(response.writes).toHaveLength(1);
    expect(pulls).toBe(1);

    response.emit("drain");
    await writing;
    expect(response.writes).toHaveLength(2);
    expect(pulls).toBe(2);
    expect(response.writableEnded).toBe(true);
  });

  it("zeroizes each serialized frame only after the transport flush completes", async () => {
    const response = new BackpressureResponse();
    const frame = Uint8Array.of(7, 8, 9);
    async function* frames(): AsyncGenerator<Uint8Array> {
      yield frame;
    }

    const writing = writeAgentBackupV2StreamResponse(response, frames());
    await nextTurn();
    expect(frame).toEqual(Uint8Array.of(7, 8, 9));
    response.emit("drain");
    await writing;

    expect(response.writes).toEqual([Uint8Array.of(7, 8, 9)]);
    expect(frame).toEqual(Uint8Array.of(0, 0, 0));
  });

  it("abandons a backpressured writer immediately on abort", async () => {
    const response = new BackpressureResponse();
    const controller = new AbortController();
    async function* frames(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.of(1);
      yield Uint8Array.of(2);
    }

    const writing = writeAgentBackupV2StreamResponse(response, frames(), {
      signal: controller.signal,
    });
    await nextTurn();
    controller.abort(new Error("deadline"));

    await expect(writing).rejects.toThrow("deadline");
    expect(response.writes).toHaveLength(1);
    expect(response.writableEnded).toBe(false);
  });
});

describe("handleAgentBackupV2SnapshotRequest", () => {
  it("serves a parseable framed capture through a real HTTP connection", async () => {
    const config: ElizaConfig = {};
    const port = await listen((req, res) =>
      handleAgentBackupV2SnapshotRequest(req, res, {
        runtime: { agentId: ids.agent },
        config,
        components: [source()],
      }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/snapshot/v2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
    );
    expect(response.headers.get("x-eliza-backup-operation-id")).toBe(
      ids.operation,
    );
    if (!response.body) throw new Error("Capture response has no body");
    const kinds: string[] = [];
    for await (const frame of parseAgentBackupCaptureV2Frames(
      responseChunks(response.body),
      {
        digest: (bytes) => createHash("sha256").update(bytes).digest(),
        sha256StreamFactory: () => {
          const hash = createHash("sha256");
          return {
            update: (bytes) => void hash.update(bytes),
            digestHex: () => hash.digest("hex"),
          };
        },
      },
    )) {
      kinds.push(frame.header.kind);
      if (frame.header.kind === "capture-start") {
        expect(frame.header.activationGeneration).toBe(ids.activation);
        expect(frame.header.lifecycleRevision).toBe("91");
      }
    }
    expect(kinds).toEqual([
      "capture-start",
      "component-start",
      "data",
      "component-end",
      "capture-end",
    ]);
  });

  it("rejects wrong-agent and non-strict requests before binary headers", async () => {
    const config: ElizaConfig = {};
    const port = await listen((req, res) =>
      handleAgentBackupV2SnapshotRequest(req, res, {
        runtime: { agentId: ids.agent },
        config,
        components: [source()],
      }),
    );
    const wrongAgent = await fetch(`http://127.0.0.1:${port}/api/snapshot/v2`, {
      method: "POST",
      body: JSON.stringify(request("44444444-4444-4444-8444-444444444444")),
    });
    expect(wrongAgent.status).toBe(409);
    await expect(wrongAgent.json()).resolves.toMatchObject({
      code: "AGENT_BACKUP_V2_AGENT_MISMATCH",
    });

    const extraField = await fetch(`http://127.0.0.1:${port}/api/snapshot/v2`, {
      method: "POST",
      body: JSON.stringify({ ...request(), provider: "robot" }),
    });
    expect(extraField.status).toBe(400);
    await expect(extraField.json()).resolves.toMatchObject({
      code: "AGENT_BACKUP_V2_INVALID_REQUEST",
    });
  });

  it("returns stable pre-header status and retry policy for bounded PGlite failures", async () => {
    const failures = [
      {
        code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
        status: 413,
        retryAfter: null,
      },
      {
        code: "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY",
        status: 429,
        retryAfter: "5",
      },
      {
        code: "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
        status: 503,
        retryAfter: "5",
      },
      {
        code: "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED",
        status: 409,
        retryAfter: "1",
      },
    ] as const;
    let failureIndex = 0;
    const preparedSource: AgentBackupV2CaptureComponentSource = {
      ...source(),
      async prepare() {
        const failure = failures[failureIndex++];
        if (!failure) throw new Error("unexpected capture request");
        throw new AgentBackupV2CaptureError(
          "bounded PGlite failure",
          failure.code,
          undefined,
          { severity: "ephemeral" },
        );
      },
    };
    const port = await listen((req, res) =>
      handleAgentBackupV2SnapshotRequest(req, res, {
        runtime: { agentId: ids.agent },
        config: {},
        components: [preparedSource],
      }),
    );

    for (const failure of failures) {
      const response = await fetch(`http://127.0.0.1:${port}/api/snapshot/v2`, {
        method: "POST",
        body: JSON.stringify(request()),
      });
      expect(response.status).toBe(failure.status);
      expect(response.headers.get("retry-after")).toBe(failure.retryAfter);
      await expect(response.json()).resolves.toMatchObject({
        code: failure.code,
      });
    }
  });
});
