/**
 * Fidelity proof for the Shared→Dedicated memory transform: content is
 * byte-identical, identities and timestamps survive exactly, 384-dim vectors
 * land on dim_384 unchanged (so cosine ranking over transferred rows equals
 * ranking over the source rows), and anomalous dimensions are surfaced.
 * Deterministic; mirrors the live staging row shape captured 2026-08-17.
 */

import { describe, expect, test } from "bun:test";
import type { SharedAgentMemoryRow } from "../../../db/schemas/shared-agent-memories";
import {
  SHARED_TRANSFER_METADATA,
  toDedicatedMemoryExport,
  toDedicatedMemoryExports,
} from "./shared-memory-dedicated-export";

function stagingShapedRow(overrides: Partial<SharedAgentMemoryRow> = {}): SharedAgentMemoryRow {
  return {
    id: "0e12baa1-cd0d-4954-a986-c1f3b00dc518",
    organization_id: "75ae457b-801f-43e1-9d95-5585147655cd",
    user_id: "f210269b-8148-428b-8c24-91da4c95c727",
    agent_id: "8f1f7f72-0577-0b4a-b15b-229c751d5484",
    entity_id: "3a0731c4-5a3c-4a3f-9d6e-0f6f10a4c111",
    room_id: "9610511b-dff2-5ca3-989a-8e1004ff44b1",
    world_id: "022a61e3-2968-4c5a-a510-ac7bac458464",
    type: "messages",
    content: { text: "hi", source: "shared-runtime", channelType: "DM" },
    embedding: Array.from({ length: 384 }, (_, i) => Math.sin(i) / 2),
    embedding_model: "bge-small-en-v1.5",
    created_at: new Date("2026-08-17T03:44:45.770Z"),
    ...overrides,
  } as SharedAgentMemoryRow;
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("shared→dedicated memory export", () => {
  test("content is byte-identical and identities/timestamps survive exactly", () => {
    const row = stagingShapedRow();
    const out = toDedicatedMemoryExport(row);
    expect(JSON.stringify(out.memory.content)).toBe(JSON.stringify(row.content));
    expect(out.memory.id).toBe(row.id);
    expect(out.memory.agent_id).toBe(row.agent_id);
    expect(out.memory.entity_id).toBe(row.entity_id);
    expect(out.memory.room_id).toBe(row.room_id);
    expect(out.memory.world_id).toBe(row.world_id);
    expect(out.memory.type).toBe("messages");
    expect(out.memory.created_at.toISOString()).toBe("2026-08-17T03:44:45.770Z");
    expect(out.memory.metadata).toEqual({ ...SHARED_TRANSFER_METADATA });
  });

  test("384-dim vector maps to dim_384 unchanged, preserving cosine ranking", () => {
    const a = stagingShapedRow();
    const b = stagingShapedRow({
      id: "1f23cbb2-de1e-4a65-b097-d2f4c11ed629",
      content: { text: "hhii", source: "shared-runtime", channelType: "DM" },
      embedding: Array.from({ length: 384 }, (_, i) => Math.cos(i) / 3),
    } as Partial<SharedAgentMemoryRow>);
    const [ea, eb] = toDedicatedMemoryExports([a, b]);
    expect(ea?.embedding?.dim_384).toEqual(a.embedding as number[]);
    expect(eb?.embedding?.dim_384).toEqual(b.embedding as number[]);
    const query = Array.from({ length: 384 }, (_, i) => Math.sin(i) / 2 + 0.01);
    const sourceOrder =
      cosineDistance(query, a.embedding as number[]) <
      cosineDistance(query, b.embedding as number[]);
    const exportedOrder =
      cosineDistance(query, ea?.embedding?.dim_384 as number[]) <
      cosineDistance(query, eb?.embedding?.dim_384 as number[]);
    expect(exportedOrder).toBe(sourceOrder);
  });

  test("vector-less rows export without an embedding leg", () => {
    const out = toDedicatedMemoryExport(
      stagingShapedRow({ embedding: null, embedding_model: null } as Partial<SharedAgentMemoryRow>),
    );
    expect(out.embedding).toBeUndefined();
    expect(out.droppedEmbeddingDimension).toBeUndefined();
  });

  test("anomalous dimensions are surfaced, never silently dropped", () => {
    const out = toDedicatedMemoryExport(
      stagingShapedRow({
        embedding: Array.from({ length: 768 }, () => 0.1),
      } as Partial<SharedAgentMemoryRow>),
    );
    expect(out.embedding).toBeUndefined();
    expect(out.droppedEmbeddingDimension).toBe(768);
  });
});
