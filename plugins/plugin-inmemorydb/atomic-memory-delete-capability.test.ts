/**
 * Verifies that the asynchronous storage-plus-vector adapter does not advertise
 * transaction atomicity for ordinary bulk memory deletion.
 */
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const AGENT_ID = "10000000-0000-4000-8000-000000000001" as UUID;

describe("atomic memory deletion capability", () => {
  it("leaves the capability absent when storage and vector deletes cannot share a transaction", () => {
    const adapter: IDatabaseAdapter = new InMemoryDatabaseAdapter(new MemoryStorage(), AGENT_ID);

    expect(adapter.deleteMemories).toBeTypeOf("function");
    expect(adapter.deleteMemoriesAtomically).toBeUndefined();
  });
});
