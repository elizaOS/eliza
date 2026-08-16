/**
 * Exercises the canonical backup record-stream codec with fragmented in-memory
 * wire input, including digest, truncation, and non-canonical-header failures.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_BACKUP_RECORD_STREAM_V1_MAGIC,
  type AgentBackupRecordStreamV1Record,
  parseAgentBackupRecordStreamV1,
  serializeAgentBackupRecordStreamV1Magic,
  serializeAgentBackupRecordStreamV1Record,
} from "./agent-backup-record-stream-v1";

const descriptor = {
  name: "database",
  format: "synthetic-v1",
  compression: "none",
  contentKind: "opaque",
  consistency: "transactional",
} as const;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Exact private pipeline encoder retained as a compatibility oracle. */
function legacyPipelineRecord(
  code: 1 | 2 | 3,
  header: unknown,
  payload = new Uint8Array(0),
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(9);
  prefix[0] = code;
  const view = new DataView(prefix.buffer);
  view.setUint32(1, headerBytes.byteLength, false);
  view.setUint32(5, payload.byteLength, false);
  return concat([prefix, headerBytes, payload]);
}

function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  for (
    let offset = 0;
    offset <= haystack.byteLength - needle.byteLength;
    offset += 1
  ) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) {
      return offset;
    }
  }
  return -1;
}

function wire(payload: Uint8Array): Uint8Array {
  const digest = createHash("sha256").update(payload).digest("hex");
  return concat([
    serializeAgentBackupRecordStreamV1Magic(),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "component-start",
      descriptor,
    }),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "data",
      dataIndex: 0,
      offsetBytes: 0,
      payloadBytes: payload.byteLength,
      entry: null,
      payload,
    }),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "component-end",
      dataFrameCount: 1,
      payloadBytes: payload.byteLength,
      payloadSha256: digest,
    }),
  ]);
}

async function* fragments(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let size = 1;
  while (offset < bytes.byteLength) {
    const end = Math.min(bytes.byteLength, offset + size);
    yield bytes.slice(offset, end);
    offset = end;
    size = size === 17 ? 1 : size + 1;
  }
}

function sha256Factory() {
  return () => {
    const hash = createHash("sha256");
    return {
      update(bytes: Uint8Array) {
        hash.update(bytes);
      },
      digestHex() {
        return hash.digest("hex");
      },
    };
  };
}

async function parse(
  bytes: Uint8Array,
): Promise<AgentBackupRecordStreamV1Record[]> {
  const records: AgentBackupRecordStreamV1Record[] = [];
  for await (const record of parseAgentBackupRecordStreamV1(fragments(bytes), {
    sha256StreamFactory: sha256Factory(),
  })) {
    records.push(record);
  }
  return records;
}

describe("agent backup record stream v1", () => {
  it("is byte-compatible with the pre-extraction capture pipeline encoder", () => {
    const payload = new TextEncoder().encode("pipeline compatibility");
    const digest = createHash("sha256").update(payload).digest("hex");
    const records = [
      {
        record: {
          kind: "component-start" as const,
          descriptor,
        },
        legacy: legacyPipelineRecord(1, { descriptor }),
      },
      {
        record: {
          kind: "data" as const,
          dataIndex: 0,
          offsetBytes: 0,
          payloadBytes: payload.byteLength,
          entry: null,
          payload,
        },
        legacy: legacyPipelineRecord(
          2,
          {
            dataIndex: 0,
            offsetBytes: 0,
            payloadBytes: payload.byteLength,
            entry: null,
          },
          payload,
        ),
      },
      {
        record: {
          kind: "component-end" as const,
          dataFrameCount: 1,
          payloadBytes: payload.byteLength,
          payloadSha256: digest,
        },
        legacy: legacyPipelineRecord(3, {
          dataFrameCount: 1,
          payloadBytes: payload.byteLength,
          payloadSha256: digest,
        }),
      },
    ];
    for (const { record, legacy } of records) {
      expect(concat(serializeAgentBackupRecordStreamV1Record(record))).toEqual(
        legacy,
      );
    }
  });

  it("preserves the deployed magic and parses arbitrarily fragmented canonical bytes", async () => {
    expect(
      new TextDecoder().decode(serializeAgentBackupRecordStreamV1Magic()),
    ).toBe(AGENT_BACKUP_RECORD_STREAM_V1_MAGIC);
    expect(AGENT_BACKUP_RECORD_STREAM_V1_MAGIC).toBe("ELZ2REC1");
    const payload = new TextEncoder().encode("durable database bytes");
    const records = await parse(wire(payload));
    expect(records.map((record) => record.kind)).toEqual([
      "component-start",
      "data",
      "component-end",
    ]);
    expect(records[1]).toMatchObject({
      dataIndex: 0,
      offsetBytes: 0,
      payloadBytes: payload.byteLength,
    });
    expect((records[1] as { payload: Uint8Array }).payload).toEqual(payload);
  });

  it("rejects truncation, trailing bytes, and payload-digest mismatch", async () => {
    const encoded = wire(Uint8Array.of(1, 2, 3, 4));
    await expect(parse(encoded.slice(0, -1))).rejects.toMatchObject({
      code: "BACKUP_RECORD_STREAM_V1_TRUNCATED",
    });
    await expect(
      parse(concat([encoded, Uint8Array.of(0)])),
    ).rejects.toMatchObject({
      code: "BACKUP_RECORD_STREAM_V1_TRAILING_DATA",
    });
    const changed = Uint8Array.from(encoded);
    const payloadOffset = findSequence(changed, Uint8Array.of(1, 2, 3, 4));
    expect(payloadOffset).toBeGreaterThan(0);
    changed[payloadOffset] = 9;
    await expect(parse(changed)).rejects.toMatchObject({
      code: "BACKUP_RECORD_STREAM_V1_PAYLOAD_DIGEST_MISMATCH",
    });
  });

  it("rejects a semantically valid but byte-noncanonical header", async () => {
    const start = serializeAgentBackupRecordStreamV1Record({
      kind: "component-start",
      descriptor,
    });
    const canonicalHeader = JSON.parse(new TextDecoder().decode(start[3])) as {
      descriptor: typeof descriptor;
    };
    const reordered = new TextEncoder().encode(
      JSON.stringify({
        descriptor: {
          format: canonicalHeader.descriptor.format,
          name: canonicalHeader.descriptor.name,
          compression: canonicalHeader.descriptor.compression,
          contentKind: canonicalHeader.descriptor.contentKind,
          consistency: canonicalHeader.descriptor.consistency,
        },
      }),
    );
    const prefix = new Uint8Array(9);
    prefix[0] = 1;
    const view = new DataView(prefix.buffer);
    view.setUint32(1, reordered.byteLength, false);
    view.setUint32(5, 0, false);
    const malformed = concat([
      serializeAgentBackupRecordStreamV1Magic(),
      prefix,
      reordered,
    ]);
    await expect(parse(malformed)).rejects.toMatchObject({
      code: "BACKUP_RECORD_STREAM_V1_HEADER_NON_CANONICAL",
    });
  });

  it("cancels a stuck iterator, bounds close, and erases late plaintext", async () => {
    const controller = new AbortController();
    const latePlaintext = new Uint8Array(32).fill(0x5a);
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
    const parser = parseAgentBackupRecordStreamV1(source, {
      sha256StreamFactory: sha256Factory(),
      signal: controller.signal,
    });
    const pending = parser.next();
    await Promise.resolve();
    controller.abort(new Error("test cancellation"));
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({
      code: "BACKUP_RECORD_STREAM_V1_ABORTED",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(returnCalls).toBe(1);
    expect(resolveNext).toBeDefined();
    resolveNext?.({ done: false, value: latePlaintext });
    await Promise.resolve();
    await Promise.resolve();
    expect(latePlaintext.every((byte) => byte === 0)).toBe(true);
  });

  it("does not let a stuck ingress read outlive its operation deadline", async () => {
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
    const parser = parseAgentBackupRecordStreamV1(source, {
      sha256StreamFactory: sha256Factory(),
      deadlineEpochMs: Date.now() + 20,
    });
    await expect(parser.next()).rejects.toMatchObject({
      code: "BACKUP_RECORD_STREAM_V1_DEADLINE_EXCEEDED",
    });
    expect(returnCalls).toBe(1);
  });
});
