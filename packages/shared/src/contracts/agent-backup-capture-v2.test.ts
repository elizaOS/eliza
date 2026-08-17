/**
 * Exercises the real binary capture-v2 encoder and incremental decoder with
 * deterministic in-memory bytes. The suite covers arbitrary fragmentation,
 * lifecycle fencing, frame tamper, component digests, and zero-progress input.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  AgentBackupCaptureV2FileEntrySchema,
  type AgentBackupCaptureV2FrameHeader,
  type AgentBackupCaptureV2Sha256Digest,
  type AgentBackupCaptureV2Sha256StreamFactory,
  parseAgentBackupCaptureV2Frames,
  parseAgentBackupCaptureV2Request,
  readAgentBackupCaptureV2FrameDigest,
  serializeAgentBackupCaptureV2Frame,
} from "./agent-backup-capture-v2.js";

const ids = {
  operation: "11111111-1111-4111-8111-111111111111",
  agent: "22222222-2222-4222-8222-222222222222",
  activation: "33333333-3333-4333-8333-333333333333",
};

const nodeDigest: AgentBackupCaptureV2Sha256Digest = (bytes) =>
  createHash("sha256").update(bytes).digest();

const nodeStreamFactory: AgentBackupCaptureV2Sha256StreamFactory = () => {
  const hash = createHash("sha256");
  return {
    update(bytes) {
      hash.update(bytes);
    },
    digestHex() {
      return hash.digest("hex");
    },
  };
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function validCapture(
  payload = new TextEncoder().encode("capture payload"),
  overrides: { componentPayloadSha256?: string } = {},
): Promise<Uint8Array[]> {
  const base = {
    format: AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT,
    schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  } as const;
  const headers: AgentBackupCaptureV2FrameHeader[] = [
    {
      ...base,
      kind: "capture-start",
      sequence: 0,
      operationId: ids.operation,
      agentId: ids.agent,
      activationGeneration: ids.activation,
      lifecycleRevision: "42",
      createdAt: "2026-08-15T12:00:00.000Z",
      componentCount: 1,
      maxFramePayloadBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
    },
    {
      ...base,
      kind: "component-start",
      sequence: 1,
      componentIndex: 0,
      component: {
        name: "database",
        format: "raw-v1",
        compression: "none",
        contentKind: "opaque",
        consistency: "transactional",
      },
    },
    {
      ...base,
      kind: "data",
      sequence: 2,
      componentIndex: 0,
      componentName: "database",
      dataIndex: 0,
      offsetBytes: 0,
      payloadBytes: payload.length,
    },
    {
      ...base,
      kind: "component-end",
      sequence: 3,
      componentIndex: 0,
      componentName: "database",
      dataFrameCount: 1,
      plainBytes: payload.length,
      payloadSha256: overrides.componentPayloadSha256 ?? sha256Hex(payload),
    },
  ];
  const frames: Uint8Array[] = [];
  for (const header of headers) {
    frames.push(
      await serializeAgentBackupCaptureV2Frame(
        { header, payload: header.kind === "data" ? payload : undefined },
        nodeDigest,
      ),
    );
  }
  const chainDigest = sha256Hex(
    concat(frames.map(readAgentBackupCaptureV2FrameDigest)),
  );
  frames.push(
    await serializeAgentBackupCaptureV2Frame(
      {
        header: {
          ...base,
          kind: "capture-end",
          sequence: 4,
          componentCount: 1,
          dataFrameCount: 1,
          plainBytes: payload.length,
          frameDigestChainSha256: chainDigest,
        },
      },
      nodeDigest,
    ),
  );
  return frames;
}

async function* fragment(
  bytes: Uint8Array,
  chunkSizes: readonly number[],
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = chunkSizes[index % chunkSizes.length] ?? 1;
    yield bytes.subarray(offset, Math.min(bytes.length, offset + size));
    offset += size;
    index += 1;
  }
}

async function decode(
  bytes: Uint8Array,
): Promise<AgentBackupCaptureV2FrameHeader[]> {
  const headers: AgentBackupCaptureV2FrameHeader[] = [];
  for await (const frame of parseAgentBackupCaptureV2Frames(
    fragment(bytes, [1, 7, 31, 257]),
    { digest: nodeDigest, sha256StreamFactory: nodeStreamFactory },
  )) {
    headers.push(frame.header);
  }
  return headers;
}

describe("agent backup capture v2 contract", () => {
  it("parses a strict request and preserves activation/lifecycle fencing", () => {
    const request = parseAgentBackupCaptureV2Request({
      format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      operationId: ids.operation,
      agentId: ids.agent,
      activationGeneration: ids.activation,
      lifecycleRevision: "18446744073709551615",
      deadlineEpochMs: Date.now() + 60_000,
    });

    expect(request.activationGeneration).toBe(ids.activation);
    expect(request.lifecycleRevision).toBe("18446744073709551615");
    expect(Object.isFrozen(request)).toBe(true);
    expect(() =>
      parseAgentBackupCaptureV2Request({
        ...request,
        lifecycleRevision: "01",
      }),
    ).toThrow();
    expect(() =>
      parseAgentBackupCaptureV2Request({ ...request, provider: "robot" }),
    ).toThrow();
  });

  it("round-trips an arbitrarily fragmented authenticated stream", async () => {
    const headers = await decode(concat(await validCapture()));

    expect(headers.map((header) => header.kind)).toEqual([
      "capture-start",
      "component-start",
      "data",
      "component-end",
      "capture-end",
    ]);
    expect(headers[0]).toMatchObject({
      operationId: ids.operation,
      activationGeneration: ids.activation,
      lifecycleRevision: "42",
    });
  });

  it("rejects path aliases containing internal dot segments", () => {
    expect(() =>
      AgentBackupCaptureV2FileEntrySchema.parse({
        path: "safe/./same.txt",
        fileOffsetBytes: 0,
        fileSizeBytes: 1,
        mode: 0o600,
        mtimeMs: 0,
      }),
    ).toThrow(/normalized relative path/);
  });

  it("returns owned payload bytes that cannot be mutated by the source", async () => {
    const payload = Uint8Array.of(0x61, 0x62, 0x63, 0x64);
    const wire = concat(await validCapture(payload));
    async function* oneChunk(): AsyncGenerator<Uint8Array> {
      yield wire;
    }
    const parser = parseAgentBackupCaptureV2Frames(oneChunk(), {
      digest: nodeDigest,
      sha256StreamFactory: nodeStreamFactory,
    });
    await parser.next();
    await parser.next();
    const data = await parser.next();
    if (data.done || data.value.header.kind !== "data") {
      throw new Error("expected the authenticated data frame");
    }
    const expected = Uint8Array.from(data.value.payload);

    wire.fill(0x9e);

    expect(data.value.payload).toEqual(expected);
    await parser.return(undefined);
  });

  it("detects a flipped byte before exposing a successful capture end", async () => {
    const frames = await validCapture();
    const tampered = frames.map((frame) => frame.slice());
    const dataFrame = tampered[2];
    if (!dataFrame) throw new Error("missing data frame");
    dataFrame[dataFrame.length - 33] =
      (dataFrame[dataFrame.length - 33] ?? 0) ^ 1;

    await expect(decode(concat(tampered))).rejects.toMatchObject({
      code: "CAPTURE_V2_FRAME_TAMPERED",
    });
  });

  it("verifies the component digest without buffering its payload", async () => {
    const wire = concat(
      await validCapture(undefined, { componentPayloadSha256: "0".repeat(64) }),
    );

    await expect(decode(wire)).rejects.toMatchObject({
      code: "CAPTURE_V2_COMPONENT_DIGEST",
    });
  });

  it("rejects zero-progress ingress and incomplete captures", async () => {
    async function* emptyChunk(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(0);
    }
    const consume = async (
      source: AsyncIterable<Uint8Array>,
    ): Promise<void> => {
      for await (const _frame of parseAgentBackupCaptureV2Frames(source, {
        digest: nodeDigest,
      })) {
        // Consume the complete parser state machine.
      }
    };

    await expect(consume(emptyChunk())).rejects.toMatchObject({
      code: "CAPTURE_V2_ZERO_PROGRESS",
    });
    const frames = await validCapture();
    await expect(
      consume(fragment(concat(frames.slice(0, -1)), [97])),
    ).rejects.toMatchObject({ code: "CAPTURE_V2_INCOMPLETE" });
  });

  it("cancels a stuck iterator, bounds close, and erases late ingress", async () => {
    const controller = new AbortController();
    const lateIngress = new Uint8Array(32).fill(0x5a);
    let resolveNext: ((result: IteratorResult<Uint8Array>) => void) | undefined;
    let returnCalls = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((resolve) => {
              resolveNext = resolve;
            }),
          return: () => {
            returnCalls += 1;
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
        };
      },
    };
    const parser = parseAgentBackupCaptureV2Frames(source, {
      digest: nodeDigest,
      signal: controller.signal,
    });
    const pending = parser.next();
    await Promise.resolve();
    controller.abort(new Error("test cancellation"));
    const started = Date.now();

    await expect(pending).rejects.toMatchObject({ code: "CAPTURE_V2_ABORTED" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(returnCalls).toBe(1);
    expect(resolveNext).toBeDefined();
    resolveNext?.({ done: false, value: lateIngress });
    await Promise.resolve();
    await Promise.resolve();
    expect(lateIngress.every((byte) => byte === 0)).toBe(true);
  });

  it("does not let a stuck ingress read outlive its deadline", async () => {
    let returnCalls = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const parser = parseAgentBackupCaptureV2Frames(source, {
      digest: nodeDigest,
      deadlineEpochMs: Date.now() + 20,
    });

    await expect(parser.next()).rejects.toMatchObject({
      code: "CAPTURE_V2_DEADLINE_EXCEEDED",
    });
    expect(returnCalls).toBe(1);
  });

  it("checks cancellation between frames already buffered in one chunk", async () => {
    const wire = concat(await validCapture());
    async function* oneChunk(): AsyncGenerator<Uint8Array> {
      yield wire;
    }
    const controller = new AbortController();
    const parser = parseAgentBackupCaptureV2Frames(oneChunk(), {
      digest: nodeDigest,
      sha256StreamFactory: nodeStreamFactory,
      signal: controller.signal,
    });

    await expect(parser.next()).resolves.toMatchObject({
      value: { header: { kind: "capture-start" } },
    });
    controller.abort(new Error("buffered cancellation"));
    await expect(parser.next()).rejects.toMatchObject({
      code: "CAPTURE_V2_ABORTED",
    });
  });

  it("bounds a digest callback that never settles", async () => {
    const wire = concat(await validCapture());
    async function* oneChunk(): AsyncGenerator<Uint8Array> {
      yield wire;
    }
    const parser = parseAgentBackupCaptureV2Frames(oneChunk(), {
      digest: () => new Promise<Uint8Array>(() => undefined),
      deadlineEpochMs: Date.now() + 20,
    });

    await expect(parser.next()).rejects.toMatchObject({
      code: "CAPTURE_V2_DEADLINE_EXCEEDED",
    });
  });

  it("does not allow callers to raise the hard ingress chunk bound", async () => {
    const parser = parseAgentBackupCaptureV2Frames(
      fragment(new Uint8Array(0), [1]),
      {
        maxIngressChunkBytes:
          AGENT_BACKUP_CAPTURE_V2_LIMITS.maxIngressChunkBytes + 1,
      },
    );

    await expect(parser.next()).rejects.toMatchObject({
      code: "CAPTURE_V2_INGRESS_BOUND_INVALID",
    });
  });
});
