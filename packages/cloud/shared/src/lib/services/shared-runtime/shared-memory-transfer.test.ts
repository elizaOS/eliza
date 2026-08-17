/**
 * Contract tests for the sealed transfer push (#20923 rebuild). Deterministic
 * doubles for export and fetch; pins the containment blockers: the token
 * never leaves toward a non-allowlisted authority (refused BEFORE export or
 * fetch), every request carries a timeout signal, a bare-2xx or
 * non-conserving importer response is a typed failure, and totals must
 * conserve the sealed manifest.
 */

import { describe, expect, test } from "bun:test";
import {
  computeSharedMemoryTransferDigest,
  type SealedMemoryExportRow,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import type { SealedMemoryExport } from "./shared-memory-sealed-export";
import {
  assertTransferTargetAllowed,
  transferSharedMemoriesToDedicated,
} from "./shared-memory-transfer";

const AGENT = {
  id: "personal:327fd128-cb80-5f3a-aedd-47b3c465c805",
  organization_id: "75ae457b-801f-43e1-9d95-5585147655cd",
  user_id: "f210269b-8148-428b-8c24-91da4c95c727",
};
const TARGET = { baseUrl: "http://100.64.0.10:2138", apiToken: "tok" };

function row(index: number): SealedMemoryExportRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    type: "messages",
    created_at: new Date(1755400000000 + index * 1000).toISOString(),
    content: { text: `m${index}` },
    entity_id: "3a0731c4-5a3c-4a3f-9d6e-0f6f10a4c111",
    room_id: "9610511b-dff2-5ca3-989a-8e1004ff44b1",
    world_id: "022a61e3-2968-4c5a-a510-ac7bac458464",
    metadata: { source: "shared-runtime-transfer" },
    embedding: { dim_384: Array.from({ length: 384 }, () => 0.5) },
  };
}

function sealedExport(rows: SealedMemoryExportRow[]): SealedMemoryExport {
  return {
    seal: {
      row_count: rows.length,
      embedding_count: rows.filter((r) => r.embedding).length,
      digest: computeSharedMemoryTransferDigest(rows),
      source_agent_id: "55555555-5555-4555-8555-555555555555",
      organization_id: AGENT.organization_id,
      user_id: AGENT.user_id,
    },
    rows,
  };
}

function recordingFetch(
  respond: (body: { seal: { row_count: number }; rows: unknown[] }) => unknown,
) {
  const calls: Array<{
    url: string;
    signal: AbortSignal | undefined;
    auth: string;
    redirect: RequestRedirect | undefined;
  }> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      url: String(url),
      signal: init?.signal ?? undefined,
      auth: (init?.headers as Record<string, string>)?.Authorization ?? "",
      redirect: init?.redirect,
    });
    return Response.json(respond(body));
  }) as typeof fetch;
  return { impl, calls };
}

function okResponse(body: { rows: unknown[] }) {
  return {
    ok: true,
    imported: body.rows.length,
    skipped_existing: 0,
    embeddings_written: body.rows.length,
    embeddings_skipped_verified: 0,
    conflicts: [],
    digest_verified: true,
  };
}

describe("assertTransferTargetAllowed", () => {
  test("tailnet CGNAT addresses and .eliza.local pass; everything else refuses", () => {
    expect(() => assertTransferTargetAllowed("http://100.64.0.10:2138")).not.toThrow();
    expect(() => assertTransferTargetAllowed("http://100.127.9.3:2138")).not.toThrow();
    expect(() => assertTransferTargetAllowed("https://agent-x.tunnel.eliza.local")).not.toThrow();
    for (const bad of [
      "https://evil.example.com",
      "http://100.128.0.1", // outside 100.64/10
      "http://100.63.255.255",
      "https://eliza.local.evil.com",
      "ftp://100.64.0.10",
      "not a url",
    ]) {
      expect(() => assertTransferTargetAllowed(bad)).toThrow();
    }
  });
});

describe("transferSharedMemoriesToDedicated", () => {
  test("a disallowed target is refused BEFORE export or token egress", async () => {
    let exported = false;
    const net = recordingFetch(okResponse);
    await expect(
      transferSharedMemoriesToDedicated(
        AGENT,
        { baseUrl: "https://evil.example.com", apiToken: "tok" },
        {
          exportImpl: (async () => {
            exported = true;
            return sealedExport([]);
          }) as never,
          fetchImpl: net.impl,
        },
      ),
    ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_TARGET_REFUSED" });
    expect(exported).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test("pushes conservation-validated batches with timeout signals attached", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(i));
    const net = recordingFetch(okResponse);
    const result = await transferSharedMemoriesToDedicated(AGENT, TARGET, {
      exportImpl: (async () => sealedExport(rows)) as never,
      fetchImpl: net.impl,
    });
    expect(result).toEqual({
      rows: 3,
      batches: 1,
      imported: 3,
      skippedExisting: 0,
      embeddingsWritten: 3,
    });
    expect(net.calls[0]?.url).toBe("http://100.64.0.10:2138/api/memories/import");
    expect(net.calls[0]?.auth).toBe("Bearer tok");
    expect(net.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(net.calls[0]?.redirect).toBe("error");
  });

  test("the seal binds metadata and world identity", () => {
    const original = row(0);
    const metadataChanged = {
      ...original,
      metadata: { ...original.metadata, source: "tampered" },
    };
    const worldChanged = {
      ...original,
      world_id: "11111111-1111-4111-8111-111111111111",
    };
    expect(computeSharedMemoryTransferDigest([metadataChanged])).not.toBe(
      computeSharedMemoryTransferDigest([original]),
    );
    expect(computeSharedMemoryTransferDigest([worldChanged])).not.toBe(
      computeSharedMemoryTransferDigest([original]),
    );
  });

  test("a bare-2xx response failing conservation is a typed failure", async () => {
    const rows = [row(0), row(1)];
    // Importer claims ok but under-reports: imported+skipped !== rows.
    const net = recordingFetch((body) => ({
      ok: true,
      imported: body.rows.length - 1,
      skipped_existing: 0,
      embeddings_written: body.rows.length - 1,
      embeddings_skipped_verified: 0,
      conflicts: [],
      digest_verified: true,
    }));
    await expect(
      transferSharedMemoriesToDedicated(AGENT, TARGET, {
        exportImpl: (async () => sealedExport(rows)) as never,
        fetchImpl: net.impl,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_FAILED" });
  });

  test("ok:false and missing digest verification are typed failures", async () => {
    const rows = [row(0)];
    for (const bad of [
      { ...okResponse({ rows }), ok: false },
      { ...okResponse({ rows }), digest_verified: false },
    ]) {
      const net = recordingFetch(() => bad);
      await expect(
        transferSharedMemoriesToDedicated(AGENT, TARGET, {
          exportImpl: (async () => sealedExport(rows)) as never,
          fetchImpl: net.impl,
        }),
      ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_FAILED" });
    }
  });

  test("rejects malformed or negative receipts before conservation arithmetic", async () => {
    const rows = [row(0)];
    for (const bad of [
      { ...okResponse({ rows }), imported: -1, skipped_existing: 2 },
      { ...okResponse({ rows }), imported: "1" },
    ]) {
      const net = recordingFetch(() => bad);
      await expect(
        transferSharedMemoriesToDedicated(AGENT, TARGET, {
          exportImpl: (async () => sealedExport(rows)) as never,
          fetchImpl: net.impl,
        }),
      ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_FAILED" });
    }
  });

  test("a fresh container must write every batch embedding", async () => {
    const rows = [row(0), row(1)];
    const net = recordingFetch((body) => ({
      ok: true,
      imported: body.rows.length,
      skipped_existing: 0,
      // Silently dropped vectors on a fresh container must not pass.
      embeddings_written: body.rows.length - 1,
      embeddings_skipped_verified: 0,
      conflicts: [],
      digest_verified: true,
    }));
    await expect(
      transferSharedMemoriesToDedicated(AGENT, TARGET, {
        exportImpl: (async () => sealedExport(rows)) as never,
        fetchImpl: net.impl,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_FAILED" });
  });

  test("one skipped row cannot excuse missing embeddings on newly imported rows", async () => {
    const rows = [row(0), row(1), row(2)];
    const net = recordingFetch(() => ({
      ok: true,
      imported: 2,
      skipped_existing: 1,
      embeddings_written: 0,
      embeddings_skipped_verified: 1,
      conflicts: [],
      digest_verified: true,
    }));
    await expect(
      transferSharedMemoriesToDedicated(AGENT, TARGET, {
        exportImpl: (async () => sealedExport(rows)) as never,
        fetchImpl: net.impl,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_FAILED" });
  });

  test("skipped rows cannot be misreported as newly written embeddings", async () => {
    const rows = [row(0), row(1)];
    const net = recordingFetch(() => ({
      ok: true,
      imported: 0,
      skipped_existing: 2,
      embeddings_written: 2,
      embeddings_skipped_verified: 0,
      conflicts: [],
      digest_verified: true,
    }));
    await expect(
      transferSharedMemoriesToDedicated(AGENT, TARGET, {
        exportImpl: (async () => sealedExport(rows)) as never,
        fetchImpl: net.impl,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MEMORY_TRANSFER_FAILED" });
  });

  test("an empty history is a zero-count no-op without network calls", async () => {
    const net = recordingFetch(okResponse);
    const result = await transferSharedMemoriesToDedicated(AGENT, TARGET, {
      exportImpl: (async () => sealedExport([])) as never,
      fetchImpl: net.impl,
    });
    expect(result.rows).toBe(0);
    expect(net.calls).toHaveLength(0);
  });
});
