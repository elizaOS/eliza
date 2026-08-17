import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
  AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  type AgentBackupCaptureV2FrameHeader,
  type AgentBackupCaptureV2Request,
  readAgentBackupCaptureV2FrameDigest,
  serializeAgentBackupCaptureV2Frame,
} from "@elizaos/shared";
import {
  AgentBackupCaptureV2HttpError,
  openAgentBackupCaptureV2,
} from "./agent-backup-capture-v2-client";

const request: AgentBackupCaptureV2Request = {
  format: "elizaos.agent-backup.capture-request",
  schemaVersion: 2,
  operationId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  activationGeneration: "33333333-3333-4333-8333-333333333333",
  lifecycleRevision: "7",
  deadlineEpochMs: 2_000_000,
};

async function wireFrames(): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = [];
  const digests: Uint8Array[] = [];
  const push = async (header: AgentBackupCaptureV2FrameHeader, payload?: Uint8Array) => {
    const wire = await serializeAgentBackupCaptureV2Frame({ header, payload });
    frames.push(wire);
    digests.push(readAgentBackupCaptureV2FrameDigest(wire));
  };
  await push({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: 0,
    kind: "capture-start",
    operationId: request.operationId,
    agentId: request.agentId,
    activationGeneration: request.activationGeneration,
    lifecycleRevision: request.lifecycleRevision,
    createdAt: "2026-08-15T10:00:00.000Z",
    componentCount: 1,
    maxFramePayloadBytes: 256 * 1024,
  });
  await push({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: 1,
    kind: "component-start",
    componentIndex: 0,
    component: {
      name: "database",
      format: "opaque-v1",
      compression: "none",
      contentKind: "opaque",
      consistency: "transactional",
    },
  });
  const payload = new TextEncoder().encode("durable state");
  await push(
    {
      format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      sequence: 2,
      kind: "data",
      componentIndex: 0,
      componentName: "database",
      dataIndex: 0,
      offsetBytes: 0,
      payloadBytes: payload.byteLength,
    },
    payload,
  );
  await push({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: 3,
    kind: "component-end",
    componentIndex: 0,
    componentName: "database",
    dataFrameCount: 1,
    plainBytes: payload.byteLength,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
  });
  const chain = createHash("sha256");
  for (const digest of digests) chain.update(digest);
  await push({
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
    sequence: 4,
    kind: "capture-end",
    componentCount: 1,
    dataFrameCount: 1,
    plainBytes: payload.byteLength,
    frameDigestChainSha256: chain.digest("hex"),
  });
  return frames;
}

function responseFor(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const frame = frames.shift();
        if (frame) controller.enqueue(frame);
        else controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
        "X-Eliza-Backup-Operation-Id": request.operationId,
      },
    },
  );
}

describe("openAgentBackupCaptureV2", () => {
  it("authenticates the exact v2 route and enforces stream fences", async () => {
    const frames = await wireFrames();
    let observedUrl = "";
    const fetchStub: typeof fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        observedUrl = String(url);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer secret-token");
        expect(headers.get("x-api-key")).toBe("secret-token");
        expect(headers.get("x-eliza-token")).toBe("secret-token");
        expect(init?.redirect).toBe("manual");
        expect(JSON.parse(String(init?.body))).toEqual(request);
        return responseFor([...frames]);
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;

    const kinds: string[] = [];
    for await (const frame of openAgentBackupCaptureV2({
      agentApiBaseUrl: "https://agent.example.test/base/",
      apiToken: " secret-token ",
      request,
      fetch: fetchStub,
      now: () => 1_200_000,
    })) {
      kinds.push(frame.header.kind);
    }

    expect(observedUrl).toBe("https://agent.example.test/base/api/snapshot/v2");
    expect(kinds).toEqual([
      "capture-start",
      "component-start",
      "data",
      "component-end",
      "capture-end",
    ]);
  });

  it("rejects a tampered frame before yielding a false terminal capture", async () => {
    const frames = await wireFrames();
    frames[2] = Uint8Array.from(frames[2] ?? [], (byte, index) => (index === 20 ? byte ^ 1 : byte));
    const fetchStub = (async () => responseFor(frames)) as typeof fetch;
    const consume = async (): Promise<void> => {
      for await (const _frame of openAgentBackupCaptureV2({
        agentApiBaseUrl: "https://agent.example.test",
        apiToken: "secret-token",
        request,
        fetch: fetchStub,
        now: () => 1_200_000,
      })) {
        // Intentionally consume through the tampered frame.
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "CAPTURE_V2_FRAME_TAMPERED" });
  });

  it("fails closed on an operation response-header mismatch", async () => {
    const frames = await wireFrames();
    const fetchStub = (async () => {
      const response = responseFor(frames);
      response.headers.set("X-Eliza-Backup-Operation-Id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      return response;
    }) as typeof fetch;
    const consume = async (): Promise<void> => {
      for await (const _frame of openAgentBackupCaptureV2({
        agentApiBaseUrl: "https://agent.example.test",
        apiToken: "secret-token",
        request,
        fetch: fetchStub,
        now: () => 1_200_000,
      })) {
        // No frame may be accepted with the wrong response fence.
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(AgentBackupCaptureV2HttpError);
    await expect(consume()).rejects.toMatchObject({
      code: "AGENT_BACKUP_V2_HTTP_OPERATION_MISMATCH",
    });
  });

  it("preserves only an allowlisted remote failure with its exact status", async () => {
    const consume = async (status: number, body: unknown): Promise<void> => {
      for await (const _frame of openAgentBackupCaptureV2({
        agentApiBaseUrl: "https://agent.example.test",
        apiToken: "secret-token",
        request,
        fetch: (async () =>
          new Response(body instanceof Uint8Array ? body : JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          })) as typeof fetch,
        now: () => 1_200_000,
      })) {
        // Error responses cannot yield capture frames.
      }
    };

    await expect(
      consume(413, {
        error: "PGlite is larger than the bounded exporter limit",
        code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_V2_HTTP_STATUS",
      status: 413,
      remoteCode: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
    });
    await expect(
      consume(503, {
        error: "The process RSS budget is temporarily exhausted",
        code: "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
      }),
    ).rejects.toMatchObject({
      status: 503,
      remoteCode: "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED",
    });
  });

  it("does not trust unknown, malformed, or status-mismatched remote codes", async () => {
    const capture = async (status: number, body: unknown): Promise<unknown> => {
      try {
        for await (const _frame of openAgentBackupCaptureV2({
          agentApiBaseUrl: "https://agent.example.test",
          apiToken: "secret-token",
          request,
          fetch: (async () =>
            new Response(body instanceof Uint8Array ? body : JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            })) as typeof fetch,
          now: () => 1_200_000,
        })) {
          // Error responses cannot yield capture frames.
        }
      } catch (error) {
        return error;
      }
      throw new Error("Expected capture-v2 HTTP failure");
    };

    for (const error of [
      await capture(503, {
        error: "wrong status",
        code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
      }),
      await capture(500, { error: "unknown", code: "AGENT_BACKUP_V2_DELETE_EVERYTHING" }),
      await capture(413, {
        error: "extra untrusted shape",
        code: "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT",
        terminal: true,
      }),
      await capture(
        413,
        new Uint8Array([
          ...new TextEncoder().encode('{"error":"'),
          0xff,
          ...new TextEncoder().encode('","code":"AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT"}'),
        ]),
      ),
    ]) {
      expect(error).toMatchObject({
        code: "AGENT_BACKUP_V2_HTTP_STATUS",
        remoteCode: undefined,
      });
    }
  });
});
