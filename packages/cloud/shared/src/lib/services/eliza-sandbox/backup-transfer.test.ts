/** Exercises sandbox backup transfer contracts with deterministic external-boundary fixtures. Real durable authority is covered separately by the PGlite suites. */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox, AgentSandboxBackup } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { logger } from "../../utils/logger";
import { SandboxBackup } from "./backup/service.js";
import { installSandboxDatabaseSimulation } from "./test-support/database.js";
import { customSandbox, fetchHeaders, fetchUrl } from "./test-support/fixtures.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterEach } from "bun:test";
import { sandboxTransactions } from "./test-support/database.js";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});
describe("ElizaSandboxService state restore auth", () => {
  test("attaches the agent token when restoring to a trusted bridge URL string", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: fetchUrl(input),
        headers: fetchHeaders(init?.headers),
        body: String(init?.body ?? ""),
      });
      return Response.json({ ok: true });
    });

    const sandbox = customSandbox();
    await (
      new ElizaSandboxService() as unknown as {
        pushState: (
          bridgeUrl: string,
          state: { memories: unknown[]; config: Record<string, unknown>; workspaceFiles: object },
          options: { trusted: true; authRec: Pick<AgentSandbox, "id" | "environment_vars"> },
        ) => Promise<void>;
      }
    ).pushState(
      "https://runtime.example",
      { memories: [], config: { restored: true }, workspaceFiles: {} },
      { trusted: true, authRec: sandbox },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://runtime.example/api/restore");
    expect(requests[0].headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer agent-token",
      "X-Api-Key": "agent-token",
      "X-Eliza-Token": "agent-token",
    });
    expect(JSON.parse(requests[0].body)).toEqual({
      memories: [],
      config: { restored: true },
      workspaceFiles: {},
    });
  });

  test("refuses a restore payload over the v1 restorable limit BEFORE the fetch (#17172)", async () => {
    // `/api/restore` caps its request body at the same canonical limit, so an
    // oversized push is a guaranteed far-end rejection. This runs on the
    // blue/green rollback path, where a failed request is a failed ROLLBACK —
    // so the refusal has to happen locally, before anything is sent.
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const { MAX_RESTORABLE_AGENT_BACKUP_BYTES } = await import(
      "@elizaos/shared/agent-backup-limits"
    );
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    });

    // One oversized value is enough to push the serialized body past the cap;
    // build it from a repeated char so the payload is big but cheap to make.
    const oversized = "x".repeat(MAX_RESTORABLE_AGENT_BACKUP_BYTES + 1024);
    const push = (
      new ElizaSandboxService() as unknown as {
        pushState: (
          bridgeUrl: string,
          state: { memories: unknown[]; config: Record<string, unknown>; workspaceFiles: object },
          options: { trusted: true; authRec: Pick<AgentSandbox, "id" | "environment_vars"> },
        ) => Promise<void>;
      }
    ).pushState(
      "https://runtime.example",
      { memories: [], config: { blob: oversized }, workspaceFiles: {} },
      { trusted: true, authRec: customSandbox() },
    );

    await expect(push).rejects.toThrow(/exceeds the v1 restorable limit/);
    expect(fetchCalls).toBe(0);
  });

  test("the oversized refusal is neither unrecoverable nor permanently lost (#17172)", async () => {
    // Both classifiers must say no. "Unrecoverable" authorises the fresh-boot
    // degrade, and an oversized chain is intact and decryptable — degrading it
    // would discard recoverable state because of a limit we chose. "Permanently
    // lost" additionally authorises pruning, which would destroy that chain.
    // The refusal gets its own terminal branch at each restore site instead.
    const { isUnrecoverableSnapshotError, isPermanentlyLostSnapshot } = await import(
      "../eliza-sandbox.ts?actual"
    );
    const { SnapshotPayloadTooLargeError } = await import("@elizaos/shared/agent-backup-limits");
    const err = new SnapshotPayloadTooLargeError(200, 100);

    expect(isUnrecoverableSnapshotError(err)).toBe(false);
    expect(isPermanentlyLostSnapshot(err)).toBe(false);
    expect(err.payloadBytes).toBe(200);
    expect(err.limitBytes).toBe(100);
  });

  test("pushes a restore payload that fits the v1 restorable limit (#17172)", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    });

    await (
      new ElizaSandboxService() as unknown as {
        pushState: (
          bridgeUrl: string,
          state: { memories: unknown[]; config: Record<string, unknown>; workspaceFiles: object },
          options: { trusted: true; authRec: Pick<AgentSandbox, "id" | "environment_vars"> },
        ) => Promise<void>;
      }
    ).pushState(
      "https://runtime.example",
      { memories: [], config: { small: "payload" }, workspaceFiles: {} },
      { trusted: true, authRec: customSandbox() },
    );

    expect(fetchCalls).toBe(1);
  });

  test("keeps legacy bridge URL restores unauthenticated when no sandbox record is supplied", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const requests: Array<{ headers: Record<string, string> }> = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ headers: fetchHeaders(init?.headers) });
      return Response.json({ ok: true });
    });

    await (
      new ElizaSandboxService() as unknown as {
        pushState: (
          bridgeUrl: string,
          state: { memories: unknown[]; config: Record<string, unknown>; workspaceFiles: object },
          options?: { trusted?: boolean },
        ) => Promise<void>;
      }
    ).pushState(
      "https://runtime.example",
      {
        memories: [],
        config: {},
        workspaceFiles: {},
      },
      { trusted: true },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].headers).toEqual({ "Content-Type": "application/json" });
  });

  test("logs restore error body read failures before throwing the restore status", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    globalThis.fetch = mock(async () => {
      return {
        ok: false,
        status: 502,
        text: mock(async () => {
          throw new Error("restore body stream broke");
        }),
      } as Response;
    });

    try {
      await expect(
        (
          new ElizaSandboxService() as unknown as {
            pushState: (
              bridgeUrl: string,
              state: {
                memories: unknown[];
                config: Record<string, unknown>;
                workspaceFiles: object;
              },
              options?: { trusted?: boolean },
            ) => Promise<void>;
          }
        ).pushState(
          "https://runtime.example",
          {
            memories: [],
            config: {},
            workspaceFiles: {},
          },
          { trusted: true },
        ),
      ).rejects.toThrow("State restore failed: HTTP 502");

      expect(warnSpy).toHaveBeenCalledWith(
        "[agent-sandbox] Failed to read restore error body",
        expect.objectContaining({
          status: 502,
          error: "restore body stream broke",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("ElizaSandboxService snapshot — endpoint capability", () => {
  test("a 404 from /api/snapshot (V2 image) returns the unsupported sentinel, not a hard failure", async () => {
    const { ElizaSandboxService, SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import(
      "../eliza-sandbox.ts?actual"
    );
    const rec = customSandbox();
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      rec,
    );
    const createBackupSpy = spyOn(agentSandboxesRepository, "createBackup");
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      if (url.includes("/api/snapshot")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("{}", { status: 200 });
    });
    try {
      const res = await new ElizaSandboxService().snapshot(rec.id, rec.organization_id, "auto");
      expect(res).toEqual({
        success: false,
        error: SNAPSHOT_ENDPOINT_UNSUPPORTED,
      });
      // A skipped snapshot must NOT create a backup row.
      expect(createBackupSpy).not.toHaveBeenCalled();
    } finally {
      findRunningSpy.mockRestore();
      createBackupSpy.mockRestore();
    }
  });

  test("a 503 from /api/snapshot remains a retryable transient sentinel", async () => {
    const { ElizaSandboxService, SNAPSHOT_CAPTURE_TRANSIENT } = await import(
      "../eliza-sandbox.ts?actual"
    );
    const rec = customSandbox();
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      rec,
    );
    const createBackupSpy = spyOn(agentSandboxesRepository, "createBackup");
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: "PGlite snapshot temporarily unavailable (connection closing)",
            code: "PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
    );
    try {
      await expect(
        new ElizaSandboxService().snapshot(rec.id, rec.organization_id, "auto"),
      ).resolves.toEqual({
        success: false,
        error: SNAPSHOT_CAPTURE_TRANSIENT,
        retryable: true,
      });
      expect(createBackupSpy).not.toHaveBeenCalled();
    } finally {
      findRunningSpy.mockRestore();
      createBackupSpy.mockRestore();
    }
  });

  test("an unrelated 503 remains an ordinary snapshot failure", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const findRunningSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      rec,
    );
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "Runtime not ready" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );
    try {
      await expect(
        new ElizaSandboxService().snapshot(rec.id, rec.organization_id, "auto"),
      ).rejects.toThrow("Snapshot fetch failed: HTTP 503");
    } finally {
      findRunningSpy.mockRestore();
    }
  });
});

// Snapshot fetch error-body excerpt (#18228 / #18336).
describe("readErrorBodyExcerpt (snapshot transfer diagnostics)", () => {
  function errorResponse(
    body: string,
    init?: { contentType?: string; splitAtBytes?: number[] },
  ): Response {
    const bytes = new TextEncoder().encode(body);
    const splitAt = init?.splitAtBytes ?? [bytes.length];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        for (const end of splitAt) {
          if (offset >= bytes.length) break;
          controller.enqueue(bytes.subarray(offset, Math.min(end, bytes.length)));
          offset = end;
        }
        if (offset < bytes.length) {
          controller.enqueue(bytes.subarray(offset));
        }
        controller.close();
      },
    });
    const headers = new Headers();
    if (init?.contentType) {
      headers.set("content-type", init.contentType);
    }
    return new Response(stream, { status: 500, headers });
  }

  test("returns null for an empty body", async () => {
    const { readErrorBodyExcerpt } = await import("../eliza-sandbox.ts?actual");
    expect(await readErrorBodyExcerpt(errorResponse(""))).toBeNull();
    expect(await readErrorBodyExcerpt(new Response(null, { status: 500 }))).toBeNull();
  });

  test("returns null for whitespace-only bodies", async () => {
    const { readErrorBodyExcerpt } = await import("../eliza-sandbox.ts?actual");
    expect(await readErrorBodyExcerpt(errorResponse("   \n\t  "))).toBeNull();
  });

  test("extracts JSON {error} and {message} fields from short bodies", async () => {
    const { readErrorBodyExcerpt } = await import("../eliza-sandbox.ts?actual");
    expect(
      await readErrorBodyExcerpt(
        errorResponse('{"error":"Durable Object storage quota exceeded"}', {
          contentType: "application/json",
        }),
      ),
    ).toBe("Durable Object storage quota exceeded");
    expect(
      await readErrorBodyExcerpt(
        errorResponse('{"message":"Internal agent error during snapshot serialization"}', {
          contentType: "application/json",
        }),
      ),
    ).toBe("Internal agent error during snapshot serialization");
  });

  test("returns trimmed plain-text and proxy error pages", async () => {
    const { readErrorBodyExcerpt } = await import("../eliza-sandbox.ts?actual");
    expect(
      await readErrorBodyExcerpt(
        errorResponse("  Worker exceeded CPU time limit  ", { contentType: "text/plain" }),
      ),
    ).toBe("Worker exceeded CPU time limit");
    expect(
      await readErrorBodyExcerpt(
        errorResponse("<html>Bad Gateway: upstream timeout</html>", {
          contentType: "text/html",
        }),
      ),
    ).toBe("<html>Bad Gateway: upstream timeout</html>");
  });

  test("truncates bodies past the 512-byte excerpt budget", async () => {
    const { readErrorBodyExcerpt } = await import("../eliza-sandbox.ts?actual");
    const body = "y".repeat(600);
    const excerpt = await readErrorBodyExcerpt(
      errorResponse(body, { contentType: "text/plain", splitAtBytes: [256, 512, 700] }),
    );
    expect(excerpt).toBe("y".repeat(512));
    expect(Buffer.byteLength(excerpt ?? "", "utf-8")).toBe(512);
  });

  test("flushes a multi-byte UTF-8 character split across stream chunks", async () => {
    const { readErrorBodyExcerpt } = await import("../eliza-sandbox.ts?actual");
    const excerpt = await readErrorBodyExcerpt(
      errorResponse("😀", { contentType: "text/plain", splitAtBytes: [2] }),
    );
    expect(excerpt).toBe("😀");
  });

  test("truncates at the byte budget without a garbled trailing character", async () => {
    const { readErrorBodyExcerpt } = await import("../eliza-sandbox.ts?actual");
    const body = `${"x".repeat(510)}😀`;
    const excerpt = await readErrorBodyExcerpt(
      errorResponse(body, { contentType: "text/plain", splitAtBytes: [512] }),
    );
    expect(excerpt).toBe("x".repeat(510));
  });
});

describe("snapshot hydration budgets (#16639)", () => {
  const prevRaw = process.env.ELIZA_SNAPSHOT_MAX_RAW_BYTES;

  afterEach(() => {
    if (prevRaw === undefined) delete process.env.ELIZA_SNAPSHOT_MAX_RAW_BYTES;
    else process.env.ELIZA_SNAPSHOT_MAX_RAW_BYTES = prevRaw;
  });

  function streamedResponse(body: string): Response {
    // A real streaming body so the budget is enforced chunk-by-chunk.
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = 64 * 1024;
        for (let i = 0; i < bytes.length; i += chunk) {
          controller.enqueue(bytes.subarray(i, i + chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  test("a body past the raw budget is rejected while streaming — never retained", async () => {
    const { readBodyWithinBudget } = await import("../eliza-sandbox.ts?actual");
    const oversized = "x".repeat(2 * 1024 * 1024);
    await expect(readBodyWithinBudget(streamedResponse(oversized), 1024 * 1024)).rejects.toThrow(
      "raw hydration budget",
    );
  });

  test("a body within budget streams through intact", async () => {
    const { readBodyWithinBudget } = await import("../eliza-sandbox.ts?actual");
    const body = JSON.stringify({ ok: true });
    expect(await readBodyWithinBudget(streamedResponse(body), 1024)).toBe(body);
  });

  test("file-count and expanded-byte budgets fail closed before retention", async () => {
    const { assertSnapshotExpandedBudgets } = await import("../eliza-sandbox.ts?actual");
    // Within budget: passes.
    assertSnapshotExpandedBudgets({
      memories: [],
      config: {},
      workspaceFiles: { "a.txt": "hello" },
    });
    // File-count breach via workspaceFiles.
    const manyFiles: Record<string, string> = {};
    for (let i = 0; i < 5_001; i++) manyFiles[`f${i}.txt`] = "x";
    expect(() =>
      assertSnapshotExpandedBudgets({ memories: [], config: {}, workspaceFiles: manyFiles }),
    ).toThrow("file budget");
    // Expanded-byte breach via the manifest's DECLARED size (the counter
    // takes max(declared, decoded), so neither side of a lying manifest can
    // under-count) — no giant test allocation needed.
    expect(() =>
      assertSnapshotExpandedBudgets({
        memories: [],
        config: {},
        workspaceFiles: {},
        manifest: {
          schemaVersion: 1,
          format: "elizaos.agent-backup",
          createdAt: "2026-07-19T00:00:00Z",
          agentId: "a",
          components: {
            database: { kind: "none", sha256: "s" },
            media: { kind: "file-set", rootLabel: "state-dir", files: [], sha256: "s" },
            vault: { kind: "file-set", rootLabel: "state-dir", files: [], sha256: "s" },
            character: { runtimeCharacter: {}, sha256: "s" },
            stateFiles: {
              kind: "file-set",
              rootLabel: "state-dir",
              files: [
                { path: "big.bin", sha256: "s", size: 500 * 1024 * 1024, bytesBase64: "AAAA" },
              ],
              sha256: "s",
            },
          },
          integrity: { componentHashes: {} },
        },
      }),
    ).toThrow("expanded byte budget");
  });

  test("a reader-less response under budget falls back to text() intact", async () => {
    const { readBodyWithinBudget } = await import("../eliza-sandbox.ts?actual");
    // A null-body Response is the real reader-less shape (bun keeps body null).
    expect(await readBodyWithinBudget(new Response(null), 16)).toBe("");
  });

  test("a reader-less response past the budget is rejected, not retained", async () => {
    const { readBodyWithinBudget } = await import("../eliza-sandbox.ts?actual");
    const readerless = {
      body: null,
      text: async () => "x".repeat(2048),
    } as unknown as Response;
    await expect(readBodyWithinBudget(readerless, 1024)).rejects.toThrow("raw hydration budget");
  });

  test("manifest file-sets count every component, taking max(declared, decoded)", async () => {
    const { assertSnapshotExpandedBudgets } = await import("../eliza-sandbox.ts?actual");
    // Within budget: exercises the pglite + media + vault + stateFiles loops
    // and the configFile counter without throwing. One entry declares MORE
    // than its base64 decodes to (declared wins), one declares LESS (decoded
    // wins) — both sides of the max(declared, decoded) counter.
    assertSnapshotExpandedBudgets({
      memories: [],
      config: {},
      workspaceFiles: {},
      manifest: {
        schemaVersion: 1,
        format: "elizaos.agent-backup",
        createdAt: "2026-07-19T00:00:00Z",
        agentId: "a",
        components: {
          database: {
            kind: "pglite-files",
            pglite: {
              kind: "file-set",
              rootLabel: "pglite-dir",
              files: [
                // declared 1024 > decoded 3 — the lying-manifest declared side.
                { path: "db/base", sha256: "s", size: 1024, bytesBase64: "AAAA" },
              ],
              sha256: "s",
            },
            sha256: "s",
          },
          media: {
            kind: "file-set",
            rootLabel: "state-dir",
            files: [
              // declared 1 < decoded 6 — the under-declared side loses to decode.
              { path: "m/a.png", sha256: "s", size: 1, bytesBase64: "AAAAAAAA" },
            ],
            sha256: "s",
          },
          vault: {
            kind: "file-set",
            rootLabel: "state-dir",
            files: [{ path: "v/k", sha256: "s", size: 8, bytesBase64: "AAAA" }],
            sha256: "s",
          },
          character: {
            runtimeCharacter: {},
            configFile: { path: "character.json", sha256: "s", size: 64, bytesBase64: "AAAAAAAA" },
            sha256: "s",
          },
          stateFiles: {
            kind: "file-set",
            rootLabel: "state-dir",
            files: [{ path: "s/notes.txt", sha256: "s", size: 16, bytesBase64: "AAAA" }],
            sha256: "s",
          },
        },
        integrity: { componentHashes: {} },
      },
    });
    // The same manifest shape breaches the FILE budget when a component's
    // file-set alone exceeds it — the count must come from the manifest loops,
    // not just legacy workspaceFiles.
    const manyEntries = Array.from({ length: 5_001 }, (_, i) => ({
      path: `m/f${i}`,
      sha256: "s",
      size: 1,
      bytesBase64: "AAAA",
    }));
    expect(() =>
      assertSnapshotExpandedBudgets({
        memories: [],
        config: {},
        workspaceFiles: {},
        manifest: {
          schemaVersion: 1,
          format: "elizaos.agent-backup",
          createdAt: "2026-07-19T00:00:00Z",
          agentId: "a",
          components: {
            database: { kind: "none", sha256: "s" },
            media: { kind: "file-set", rootLabel: "state-dir", files: manyEntries, sha256: "s" },
            vault: { kind: "file-set", rootLabel: "state-dir", files: [], sha256: "s" },
            character: { runtimeCharacter: {}, sha256: "s" },
            stateFiles: { kind: "file-set", rootLabel: "state-dir", files: [], sha256: "s" },
          },
          integrity: { componentHashes: {} },
        },
      }),
    ).toThrow("file budget");
  });
});

describe("ElizaSandboxService.transferStateForRelocation", () => {
  // A blue/green replacement moves the CONTAINER, not the state: agent volumes
  // are host bind-mounts, so the pglite directory does not follow a container
  // to another machine. The caller retires the source placement on the strength
  // of this answer, so the contract is that `transferred: true` is reported
  // only after a completed push — anything else is a move that did not happen.
  const SOURCE_SNAPSHOT = {
    memories: [{ id: "m1" }],
    config: { agentName: "probe" },
    workspaceFiles: {},
    manifest: { version: 1, tables: ["memories"] },
  };

  function bridgeStub(opts: { snapshotStatus?: number; restoreStatus?: number; body?: unknown }) {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      calls.push(url);
      if (url.endsWith("/api/snapshot")) {
        const status = opts.snapshotStatus ?? 200;
        if (status !== 200) return new Response("nope", { status });
        return Response.json(opts.body ?? SOURCE_SNAPSHOT);
      }
      if (url.endsWith("/api/restore")) {
        const status = opts.restoreStatus ?? 200;
        if (status !== 200) return new Response("refused", { status });
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    });
    return calls;
  }

  async function runTransfer(
    sandbox: AgentSandbox,
    options: { wireSnapshotTransaction?: boolean } = {},
  ) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const service = new ElizaSandboxService() as unknown as {
      transferStateForRelocation: (o: {
        agentId: string;
        orgId: string;
        targetBridgeUrl: string;
        authRec: Pick<AgentSandbox, "id" | "environment_vars">;
      }) => Promise<{ transferred: boolean; reason?: string; detail?: string }>;
      lockLifecycle: (tx: unknown, agentId: string, orgId: string) => Promise<void>;
      getAgentForLifecycleMutation: (
        tx: unknown,
        agentId: string,
        orgId: string,
      ) => Promise<AgentSandbox | undefined>;
      persistAuthorizedSnapshotWithinTransaction: (
        tx: unknown,
        rec: AgentSandbox,
        organizationId: string,
        snapshotType: string,
        plannedInput: Parameters<typeof agentSandboxesRepository.createBackup>[0],
      ) => Promise<AgentSandboxBackup>;
    };
    const transfer = () =>
      service.transferStateForRelocation({
        agentId: sandbox.id,
        orgId: sandbox.organization_id,
        targetBridgeUrl: "https://blue.example",
        authRec: sandbox,
      });
    if (!options.wireSnapshotTransaction) return transfer();

    sandboxTransactions.implementation = async (fn) => fn({ execute: async () => ({ rows: [] }) });
    const lockSpy = spyOn(service, "lockLifecycle").mockResolvedValue(undefined);
    const currentSpy = spyOn(service, "getAgentForLifecycleMutation").mockResolvedValue(sandbox);
    const persistSpy = spyOn(
      SandboxBackup.prototype,
      "persistAuthorizedSnapshotWithinTransaction",
    ).mockImplementation(async (_tx, rec, _organizationId, _snapshotType, plannedInput) => {
      await agentSandboxesRepository.update(rec.id, { last_backup_at: new Date() });
      return await agentSandboxesRepository.createBackup(plannedInput);
    });
    try {
      return await transfer();
    } finally {
      lockSpy.mockRestore();
      currentSpy.mockRestore();
      persistSpy.mockRestore();
      sandboxTransactions.implementation = null;
    }
  }

  test("an image with no snapshot endpoint is unrelocatable, and nothing is pushed", async () => {
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox as never,
    );
    const calls = bridgeStub({ snapshotStatus: 404 });
    try {
      const outcome = await runTransfer(sandbox);
      expect(outcome.transferred).toBe(false);
      expect(outcome.reason).toBe("capture-unsupported");
      // The decisive assertion: the replacement was never given a state, so a
      // caller that retired the source here would destroy the only copy.
      expect(calls.some((u) => u.endsWith("/api/restore"))).toBe(false);
    } finally {
      findSpy.mockRestore();
    }
  });

  test("a capture without a full manifest is refused before anything is pushed", async () => {
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox as never,
    );
    // Same shape minus the manifest: a partial capture would survive as silent
    // data loss once the source container is destroyed.
    const calls = bridgeStub({ body: { ...SOURCE_SNAPSHOT, manifest: undefined } });
    try {
      const outcome = await runTransfer(sandbox);
      expect(outcome.transferred).toBe(false);
      expect(outcome.reason).toBe("capture-failed");
      expect(outcome.detail).toContain("manifest");
      expect(calls.some((u) => u.endsWith("/api/restore"))).toBe(false);
    } finally {
      findSpy.mockRestore();
    }
  });

  test("a refused restore is never reported as transferred", async () => {
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox as never,
    );
    const backupSpy = spyOn(agentSandboxesRepository, "createBackup").mockResolvedValue({
      id: "backup-1",
      size_bytes: 4096,
    } as never);
    const stateSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue(SOURCE_SNAPSHOT as never);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(null as never);
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(
      undefined as never,
    );
    // No parent chain: forces a full backup, which is the shape a relocation
    // must carry anyway.
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined as never,
    );
    bridgeStub({ restoreStatus: 500 });
    try {
      const outcome = await runTransfer(sandbox, { wireSnapshotTransaction: true });
      expect(outcome.transferred).toBe(false);
      expect(outcome.reason).toBe("push-failed");
    } finally {
      for (const s of [findSpy, backupSpy, stateSpy, updateSpy, pruneSpy, latestSpy])
        s.mockRestore();
    }
  });

  test("reports transferred only after the restore actually completed", async () => {
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox as never,
    );
    const backupSpy = spyOn(agentSandboxesRepository, "createBackup").mockResolvedValue({
      id: "backup-1",
      size_bytes: 4096,
    } as never);
    const stateSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue(SOURCE_SNAPSHOT as never);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(null as never);
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(
      undefined as never,
    );
    // No parent chain: forces a full backup, which is the shape a relocation
    // must carry anyway.
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined as never,
    );
    const calls = bridgeStub({});
    try {
      const outcome = await runTransfer(sandbox, { wireSnapshotTransaction: true });
      expect(outcome.transferred).toBe(true);
      expect(calls.some((u) => u.endsWith("/api/snapshot"))).toBe(true);
      expect(calls.some((u) => u.endsWith("/api/restore"))).toBe(true);
    } finally {
      for (const s of [findSpy, backupSpy, stateSpy, updateSpy, pruneSpy, latestSpy])
        s.mockRestore();
    }
  });
});

let restoreDatabase: (() => void) | undefined;
beforeAll(() => {
  restoreDatabase = installSandboxDatabaseSimulation();
});
afterAll(() => {
  restoreDatabase?.();
});
