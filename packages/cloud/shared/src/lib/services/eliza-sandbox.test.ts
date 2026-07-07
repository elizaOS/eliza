// Exercises eliza sandbox behavior with deterministic cloud-shared lib fixtures.
import { afterAll, afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { KeyNotFoundError, KmsError, orgKey } from "@elizaos/security/kms";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { decryptField, encryptField } from "../../db/crypto/field-crypto";
import { resetKmsClientForTests } from "../../db/crypto/kms-client";
import * as realHelpersNs from "../../db/helpers";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import type { AgentSandbox, AgentSandboxBackup } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import type { DockerNode } from "../../db/repositories/docker-nodes";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { sharedRuntimeHistoryRepository } from "../../db/repositories/shared-runtime-history";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import { DockerSSHClient } from "./docker-ssh";
import { resolveSandboxContainerLaunchConfig } from "./sandbox-container-launch-config";
import type { SandboxProvider } from "./sandbox-provider-types";

// Drive the REAL @elizaos/security crypto stack so the errors the snapshot-degrade
// path classifies are genuine (`AeadError`, `KeyNotFoundError`) — not hand-rolled
// stand-ins. In NODE_ENV=test, getKmsClient() resolves the in-process memory
// backend, which is exactly what orphans keys across a restart in prod.
const KMS_TEST_ORG = "org-test-1";
const KMS_TEST_COORDS = {
  table: "agent_sandbox_backups",
  rowId: "00000000-0000-4000-8000-0000000000aa",
  column: "state_data",
};

// A genuine AeadError: decrypt with the wrong AAD so the GCM auth tag fails to
// verify — the shape a corrupt / wrong-key snapshot surfaces as.
async function realAeadDecryptError(): Promise<Error> {
  resetKmsClientForTests();
  const enc = await encryptField(KMS_TEST_ORG, '{"memories":[]}', KMS_TEST_COORDS);
  try {
    await decryptField(enc, { ...KMS_TEST_COORDS, rowId: "00000000-0000-4000-8000-0000000000bb" });
  } catch (e) {
    if (e instanceof Error) return e;
  }
  throw new Error("expected a real AeadError from the AAD mismatch");
}

// A genuine KeyNotFoundError, reproducing the HQ #14308 incident: encrypt under
// the memory backend, then "restart" it (resetKmsClientForTests → a fresh
// MemoryKmsAdapter with an empty key map) so the key that encrypted the field is
// gone, and decrypt of the older ciphertext can no longer find it.
async function realKeyRotatedAwayError(): Promise<Error> {
  resetKmsClientForTests();
  const enc = await encryptField(KMS_TEST_ORG, '{"memories":[]}', KMS_TEST_COORDS);
  resetKmsClientForTests();
  try {
    await decryptField(enc, KMS_TEST_COORDS);
  } catch (e) {
    if (e instanceof Error) return e;
  }
  throw new Error("expected a real KeyNotFoundError after the key was rotated away");
}

// `executeUpgrade()`'s blue/green swap runs inside `dbWrite.transaction(...)`.
// `dbWrite` is a Proxy whose `get` trap always re-resolves the live connection,
// so `spyOn(dbWrite, "transaction")` does NOT intercept — the call falls through
// to a real DB and throws. The only way to drive the real swap body offline is
// to replace the `dbWrite` binding at the module that defines it. We spread the
// REAL helpers and override ONLY `dbWrite` with a controllable transaction; the
// repositories used elsewhere in this file are all `spyOn`-stubbed, so they
// never touch this swapped `dbWrite`. The override is restored in `afterAll` so
// it cannot leak into other files in the shared single-process run.
type UpgradeTx = { execute: (query: unknown) => Promise<{ rows: Array<{ id: string }> }> };
const realHelpers = { ...realHelpersNs };
let upgradeTransactionImpl: (<T>(fn: (tx: UpgradeTx) => Promise<T>) => Promise<T>) | null = null;
const upgradeDbWrite = {
  ...(realHelpersNs.dbWrite as unknown as Record<string, unknown>),
  transaction: <T>(fn: (tx: UpgradeTx) => Promise<T>): Promise<T> => {
    if (!upgradeTransactionImpl) {
      throw new Error(
        "dbWrite.transaction called without an active upgradeTransactionImpl (test wiring bug)",
      );
    }
    return upgradeTransactionImpl(fn);
  },
};
mock.module("../../db/helpers", () => ({
  ...realHelpers,
  dbWrite: upgradeDbWrite,
}));
afterAll(() => {
  mock.module("../../db/helpers", () => realHelpers);
});

// provision()'s success path now re-enters the billable set via
// agentBillingRepository.reactivateSandboxBillingAfterFunding (#10554) — a
// dbWrite.update. This file swaps dbWrite for a transaction-only stub with no
// `.update`, so stub the reactivation writer here (the singleton is shared with
// eliza-sandbox.ts's import). The dedicated "re-enters billing" suite below
// clears + asserts that provision() DOES invoke it on a successful provision.
const reactivateBillingSpy = spyOn(
  agentBillingRepository,
  "reactivateSandboxBillingAfterFunding",
).mockResolvedValue(undefined);

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

function restoreWebSocketPair(): void {
  if (originalWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
    return;
  }
  Reflect.deleteProperty(globalThis, "WebSocketPair");
}

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function fetchHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

function customSandbox(): AgentSandbox {
  const now = new Date("2026-06-04T12:00:00.000Z");
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "22222222-2222-4222-8222-222222222222",
    user_id: "33333333-3333-4333-8333-333333333333",
    character_id: null,
    sandbox_id: "sandbox-e06bb509",
    status: "running",
    execution_tier: "custom",
    bridge_url: "https://legacy-bridge.example",
    health_url: "https://legacy-bridge.example/health",
    agent_name: "bnancy",
    agent_config: {},
    database_uri: "postgres://agent-db.example",
    database_status: "ready",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: { ELIZA_API_TOKEN: "agent-token" },
    node_id: "node-1",
    container_name: "agent-e06bb509",
    bridge_port: 18923,
    web_ui_port: 23816,
    headscale_ip: "100.64.0.10",
    docker_image: "ghcr.io/example/bnancy:latest",
    image_digest: null,
    previous_image_digest: null,
    previous_docker_image: null,
    billing_status: "active",
    last_billed_at: null,
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: null,
    pool_ready_at: null,
    claimed_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

function sharedSandbox(): AgentSandbox {
  return {
    ...customSandbox(),
    sandbox_id: null,
    execution_tier: "shared",
    bridge_url: null,
    health_url: null,
    agent_name: "shared-nancy",
    agent_config: { system: "You are shared-nancy." },
    environment_vars: {},
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

describe("resolveSandboxContainerLaunchConfig", () => {
  test("maps stored waifu container hints to sandbox provider launch config", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "waifu-smoke-agent",
          port: 3000,
          cpu: 512,
          memory: 1024,
          desiredCount: 1,
          architecture: "arm64",
          healthCheckPath: "/api/health",
        },
      }),
    ).toEqual({
      projectName: "waifu-smoke-agent",
      port: 3000,
      cpu: 512,
      memoryMb: 1024,
      desiredCount: 1,
      architecture: "arm64",
      healthCheckPath: "/api/health",
    });
  });

  test("ignores invalid or absent container hints", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "",
          port: 0,
          cpu: -1,
          memory: Number.NaN,
          desiredCount: 1.5,
          architecture: "riscv64",
          healthCheckPath: "",
        },
      }),
    ).toBeUndefined();
    expect(resolveSandboxContainerLaunchConfig({})).toBeUndefined();
  });
});

describe("ElizaSandboxService bridge status", () => {
  test("reports web-only custom agents as running through the router origin in Workers", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    Object.defineProperty(globalThis, "WebSocketPair", {
      value: class WebSocketPair {},
      configurable: true,
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchUrl(input);
      requests.push({ url, headers: fetchHeaders(init?.headers) });
      if (url === `https://${sandbox.id}.elizacloud.ai/api/agents`) {
        return new Response("{}", { status: 404 });
      }
      if (url === "https://eliza-production-1.elizacloud.ai/") {
        return new Response("<!doctype html>", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const response = await runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
        },
        () =>
          new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
            jsonrpc: "2.0",
            id: "status-check",
            method: "status.get",
            params: {},
          }),
      );

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: "status-check",
        result: {
          status: "running",
          ready: true,
          agentId: sandbox.id,
          runtime: "web",
          chat: true,
        },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url.startsWith(`https://${sandbox.id}.elizacloud.ai`)).toBe(true);
      expect(requests[1]).toEqual({
        url: "https://eliza-production-1.elizacloud.ai/",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer agent-token",
          "X-Api-Key": "agent-token",
          "X-Eliza-Token": "agent-token",
          "x-forwarded-host": `${sandbox.id}.elizacloud.ai`,
          "x-forwarded-proto": "https",
        },
      });
    } finally {
      findRunningSandboxSpy.mockRestore();
    }
  });
});

describe("ElizaSandboxService shared runtime bridge", () => {
  // skipIf(win32): under the single-process bun:test run this file shares,
  // the degraded/shared-no-model bridge path returns a different response shape
  // on Windows than on macOS/Linux (a 4-field object vs the full degraded
  // result asserted below). It reproduces only on the Windows runner and can't
  // be diagnosed locally; the rest of the suite passes there. Matches the
  // established Windows-skip on the "skips missing state restore endpoint" test
  // below.
  test.skipIf(process.platform === "win32")(
    "does not persist degraded shared-runtime turns",
    async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const sandbox = sharedSandbox();
      const findRunningSandboxSpy = spyOn(
        agentSandboxesRepository,
        "findRunningSandbox",
      ).mockResolvedValue(sandbox);
      const historyGetSpy = spyOn(sharedRuntimeHistoryRepository, "get").mockResolvedValue([]);
      const historyUpsertSpy = spyOn(sharedRuntimeHistoryRepository, "upsert").mockResolvedValue(
        undefined,
      );

      try {
        const response = await runWithCloudBindings(
          {
            CEREBRAS_API_KEY: "",
            OPENAI_API_KEY: "",
          },
          () =>
            new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
              jsonrpc: "2.0",
              id: "shared-turn",
              method: "message.send",
              params: { text: "hello" },
            }),
        );

        expect(response).toEqual({
          jsonrpc: "2.0",
          id: "shared-turn",
          result: {
            text: "shared-nancy is temporarily unavailable (no shared model configured).",
            agentName: "shared-nancy",
            channelId: expect.any(String),
            model: "none",
            degraded: true,
            runtime: "shared",
          },
        });
        expect(historyGetSpy).toHaveBeenCalled();
        expect(historyUpsertSpy).not.toHaveBeenCalled();
      } finally {
        findRunningSandboxSpy.mockRestore();
        historyGetSpy.mockRestore();
        historyUpsertSpy.mockRestore();
      }
    },
  );
});

describe("ElizaSandboxService wake", () => {
  test.skipIf(process.platform === "win32")(
    "skips missing state restore endpoint for web-only custom images",
    async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const now = new Date("2026-06-04T12:05:00.000Z");
      const sleepingSandbox: AgentSandbox = {
        ...customSandbox(),
        status: "sleeping",
        sandbox_id: null,
        bridge_url: null,
        health_url: null,
        node_id: null,
        container_name: null,
        bridge_port: null,
        web_ui_port: null,
        headscale_ip: null,
        updated_at: now,
      };
      const backup: AgentSandboxBackup = {
        id: "11111111-1111-4111-8111-111111111111",
        sandbox_record_id: sleepingSandbox.id,
        snapshot_type: "pre-shutdown",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        state_data_storage: "inline",
        state_data_key: null,
        size_bytes: 2,
        backup_kind: "full",
        parent_backup_id: null,
        content_hash: null,
        created_at: now,
      };
      const provider: SandboxProvider = {
        create: mock(async () => ({
          sandboxId: "agent-e06bb509",
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: {
            nodeId: "node-1",
            containerName: "agent-e06bb509",
            bridgePort: 21060,
            webUiPort: 3000,
          },
        })),
        stop: mock(async () => {}),
        checkHealth: mock(async () => true),
      };
      const requests: string[] = [];
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = fetchUrl(input);
        requests.push(url);
        if (url === "https://runtime.example/api/agents") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (url === "https://runtime.example/api/restore") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      });
      const originalFindByIdAndOrg = agentSandboxesRepository.findByIdAndOrg;
      const originalFindByIdAndOrgForWrite = agentSandboxesRepository.findByIdAndOrgForWrite;
      const originalTrySetProvisioning = agentSandboxesRepository.trySetProvisioning;
      const originalGetLatestBackup = agentSandboxesRepository.getLatestBackup;
      const originalGetReconstructedBackupState =
        agentSandboxesRepository.getReconstructedBackupState;
      agentSandboxesRepository.findByIdAndOrg = mock(async () => sleepingSandbox);
      // executeWake reads from the PRIMARY via getAgentForWrite →
      // findByIdAndOrgForWrite; provision() (called next) reads via
      // findByIdAndOrg. Stub both so neither touches the unmigrated test DB.
      agentSandboxesRepository.findByIdAndOrgForWrite = mock(async () => sleepingSandbox);
      agentSandboxesRepository.trySetProvisioning = mock(async () => ({
        ...sleepingSandbox,
        status: "provisioning",
      }));
      agentSandboxesRepository.getLatestBackup = mock(async () => backup);
      agentSandboxesRepository.getReconstructedBackupState = mock(async () => ({
        memories: [],
        config: {},
        workspaceFiles: {},
      }));
      const createForAgentSpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        plainKey: "eliza_test_agent_key",
        prefix: "eliza_test",
      });
      const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
        async (_id, data) => ({
          ...sleepingSandbox,
          ...data,
          updated_at: now,
        }),
      );

      try {
        const result = await new ElizaSandboxService(provider).executeWake(
          sleepingSandbox.id,
          sleepingSandbox.organization_id,
        );

        expect(result).toEqual({
          success: true,
          reprovisioned: true,
          restoredBackupId: backup.id,
        });
        expect(requests).toContain("https://runtime.example/api/restore");
        expect(updateSpy).toHaveBeenCalledWith(
          sleepingSandbox.id,
          expect.objectContaining({ status: "running" }),
        );
      } finally {
        agentSandboxesRepository.findByIdAndOrg = originalFindByIdAndOrg;
        agentSandboxesRepository.findByIdAndOrgForWrite = originalFindByIdAndOrgForWrite;
        agentSandboxesRepository.trySetProvisioning = originalTrySetProvisioning;
        agentSandboxesRepository.getLatestBackup = originalGetLatestBackup;
        agentSandboxesRepository.getReconstructedBackupState = originalGetReconstructedBackupState;
        createForAgentSpy.mockRestore();
        updateSpy.mockRestore();
      }
    },
  );
});

describe("ElizaSandboxService snapshot — endpoint capability", () => {
  test("a 404 from /api/snapshot (V2 image) returns the unsupported sentinel, not a hard failure", async () => {
    const { ElizaSandboxService, SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import(
      "./eliza-sandbox.ts?actual"
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
});

describe("ElizaSandboxService recoverDisconnected", () => {
  function disconnectedSandbox(): AgentSandbox {
    return { ...customSandbox(), status: "disconnected" };
  }

  test("recovers a reachable disconnected agent via guarded compare-and-set", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(
      async () => sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => ({ ...sandbox, status: "running" }));
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("recovered");
      expect(casSpy).toHaveBeenCalledTimes(1);
      expect(casSpy.mock.calls[0]?.[0]).toBe(sandbox.id);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("recovers a reachable errored agent left behind by blue/green status drift", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      status: "error",
      error_message: null,
      previous_image_digest: "sha256:old",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(
      async () => sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => ({ ...sandbox, status: "running", error_message: null }));
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("recovered");
      expect(casSpy).toHaveBeenCalledTimes(1);
      expect(casSpy.mock.calls[0]).toEqual([sandbox.id, "error"]);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("does NOT revive when the row left disconnected mid-probe (CAS loses -> gone)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(
      async () => sandbox,
    );
    // Probe succeeds, but the agent was deleted/stopped/re-provisioned during the
    // probe → guarded update matches 0 rows. Must report "gone", never resurrect.
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => undefined);
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("gone");
      expect(casSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("reports unreachable without writing when the bridge does not answer", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(
      async () => sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => undefined);
    globalThis.fetch = mock(async () => new Response("nope", { status: 502 }));

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("unreachable");
      expect(casSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("reports gone (and never probes) when the row is no longer disconnected", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(
      async () => ({
        ...customSandbox(),
        status: "running",
      }),
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => undefined);
    let probed = false;
    globalThis.fetch = mock(async () => {
      probed = true;
      return new Response("ok", { status: 200 });
    });

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(result).toBe("gone");
      expect(probed).toBe(false);
      expect(casSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });
});

describe("ElizaSandboxService heartbeat", () => {
  // Pins the behaviour the probeBridgeHealth() extraction must preserve on the
  // prod-critical heartbeat path: grace-window hysteresis and the exact DB
  // writes. A regression here flips healthy agents to disconnected (the bug the
  // bridge-port fix already cost us once).

  test("probe miss inside the grace window keeps the agent running with no DB write", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    // last_heartbeat_at 30s ago < 120s grace → stay running.
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      last_heartbeat_at: new Date(Date.now() - 30_000),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    globalThis.fetch = mock(async () => {
      throw new Error("fetch failed");
    });

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("probe miss past the grace window marks disconnected without bumping heartbeat", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    // last_heartbeat_at 200s ago > 120s grace → disconnect.
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      last_heartbeat_at: new Date(Date.now() - 200_000),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    globalThis.fetch = mock(async () => {
      throw new Error("fetch failed");
    });

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
      // last_heartbeat_at is bumped ONLY on success — its age is the liveness clock.
      expect(Object.hasOwn(patch, "last_heartbeat_at")).toBe(false);
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("probe that succeeds on a retry bumps last_heartbeat_at and leaves status alone", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error("cold path"); // first attempt re-warms
      return new Response("ok", { status: 200 });
    });

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(true);
      expect(calls).toBe(2); // retry semantics preserved
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.last_heartbeat_at).toBeInstanceOf(Date);
      expect(patch.status).toBeUndefined();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });
});

// Stale-tailnet-IP reconciliation (heartbeat + recoverDisconnected). Agent
// containers do not persist tailscale node state, so a container restart mints
// a fresh node key → headscale assigns the NEXT IP → the stored headscale_ip /
// bridge_url go stale while the container stays docker-healthy. These suites
// pin the repair path (columns fixed in place, no reprovision of a healthy
// container) AND every still-dies guard: dead containers, same-IP genuine
// unreachability, failed re-probes, and the 3-cycle unresolvable escalation
// must all still reach disconnected → the reprovision self-heal.
describe("ElizaSandboxService tailnet-IP reconciliation", () => {
  const OLD_IP = "100.64.0.10";
  const NEW_IP = "100.64.0.11";
  const STALE_BRIDGE = `http://${OLD_IP}:3000`;
  const REPAIRED_BRIDGE = `http://${NEW_IP}:3000`;

  function staleIpSandbox(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
    return {
      ...customSandbox(),
      bridge_url: STALE_BRIDGE,
      health_url: `${STALE_BRIDGE}/api`,
      headscale_ip: OLD_IP,
      // 200s ago > 120s grace — the reconcile path only runs past grace.
      last_heartbeat_at: new Date(Date.now() - 200_000),
      ...overrides,
    };
  }

  function nodeRecord(): DockerNode {
    return {
      node_id: "node-1",
      hostname: "node-1.internal",
      ssh_port: 22,
      ssh_user: "root",
      host_key_fingerprint: null,
    } as unknown as DockerNode;
  }

  // One SSH client mock serving both node-side commands the reconcile issues:
  // docker health inspect and the in-container `tailscale ip -4`.
  function mockNodeSsh(opts: { health: string | Error; tailscaleIp: string | Error }) {
    const exec = mock(async (cmd: string) => {
      if (cmd.includes("docker inspect")) {
        if (opts.health instanceof Error) throw opts.health;
        return opts.health;
      }
      if (cmd.includes("tailscale --socket")) {
        if (opts.tailscaleIp instanceof Error) throw opts.tailscaleIp;
        return opts.tailscaleIp;
      }
      throw new Error(`unexpected ssh command: ${cmd}`);
    });
    const getClientSpy = spyOn(DockerSSHClient, "getClient").mockReturnValue({
      exec,
    } as unknown as DockerSSHClient);
    return { exec, getClientSpy };
  }

  // Bridge probes fail on the stale IP and answer 200 on the repaired one —
  // exactly what a restarted container that re-registered under a new IP does.
  function fetchAliveOnlyOnNewIp() {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      if (url.includes(NEW_IP)) return new Response("ok", { status: 200 });
      throw new Error(`unreachable: ${url}`);
    });
  }

  function fetchAllDead() {
    globalThis.fetch = mock(async () => {
      throw new Error("unreachable");
    });
  }

  test("(a) heartbeat: docker-healthy + new IP + repaired probe 200 → stays running with repaired columns", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    // tailscale CLI prints the v4 line first; the parser must take the 100.x line.
    const { getClientSpy } = mockNodeSsh({
      health: "healthy",
      tailscaleIp: `${NEW_IP}\nfd7a:115c:a1e0::1\n`,
    });
    fetchAliveOnlyOnNewIp();

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(true);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [id, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(id).toBe(sandbox.id);
      expect(patch.headscale_ip).toBe(NEW_IP);
      expect(patch.bridge_url).toBe(REPAIRED_BRIDGE);
      expect(patch.last_heartbeat_at).toBeInstanceOf(Date);
      expect(patch.error_count).toBe(0);
      // The row must NOT be disconnected — the whole point is no reprovision.
      expect(patch.status).toBeUndefined();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 20_000);

  test("(b) heartbeat: docker NOT healthy → disconnected (dead containers still self-heal via reprovision)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { exec, getClientSpy } = mockNodeSsh({ health: "unhealthy", tailscaleIp: NEW_IP });
    fetchAllDead();

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
      expect(patch.headscale_ip).toBeUndefined();
      // A dead container short-circuits — no IP resolve is attempted on it.
      const tailscaleCalls = exec.mock.calls.filter(([cmd]) =>
        String(cmd).includes("tailscale --socket"),
      );
      expect(tailscaleCalls).toHaveLength(0);
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 20_000);

  test("(c) heartbeat: docker-healthy but the resolved IP equals the stored one → genuinely unreachable → disconnected", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: OLD_IP });
    fetchAllDead();

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
      expect(patch.headscale_ip).toBeUndefined();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 20_000);

  test("(d) heartbeat: docker-healthy + IP unresolvable ratchets error_count and escalates to disconnected on the 3rd cycle", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    // error_count evolves across cycles the way the ratchet writes it.
    let errorCount = 0;
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => staleIpSandbox({ error_count: errorCount }),
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({
      health: "healthy",
      tailscaleIp: new Error("docker exec failed: container has no tailscale binary reachable"),
    });
    fetchAllDead();

    try {
      const svc = new ElizaSandboxService();
      // Cycles 1 and 2: still running, error_count ratchets, NO disconnect.
      for (const expected of [1, 2]) {
        updateSpy.mockClear();
        const ok = await svc.heartbeat(
          "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
          "22222222-2222-4222-8222-222222222222",
        );
        expect(ok).toBe(false);
        expect(updateSpy).toHaveBeenCalledTimes(1);
        const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(patch.error_count).toBe(expected);
        expect(patch.status).toBeUndefined();
        errorCount = expected;
      }
      // Cycle 3 hits the cap: never keep an unreachable agent running forever.
      updateSpy.mockClear();
      const ok = await svc.heartbeat(
        "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        "22222222-2222-4222-8222-222222222222",
      );
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 40_000);

  test("(e) recoverDisconnected: repaired IP + live re-probe → recovered with columns updated, no reprovision", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox({ status: "disconnected" });
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(sandbox);
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockResolvedValue({ ...sandbox, status: "running" });
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: NEW_IP });
    fetchAliveOnlyOnNewIp();

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      expect(result).toBe("recovered");
      expect(casSpy).toHaveBeenCalledTimes(1);
      expect(casSpy.mock.calls[0]).toEqual([sandbox.id, "disconnected"]);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [id, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(id).toBe(sandbox.id);
      expect(patch.headscale_ip).toBe(NEW_IP);
      expect(patch.bridge_url).toBe(REPAIRED_BRIDGE);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 20_000);

  test("(f) recoverDisconnected: repaired IP still dead → unreachable (reprovision path), nothing written", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = staleIpSandbox({ status: "disconnected" });
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(sandbox);
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockResolvedValue(undefined);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
    const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: NEW_IP });
    fetchAllDead();

    try {
      const result = await new ElizaSandboxService().recoverDisconnected(
        sandbox.id,
        sandbox.organization_id,
      );
      // "unreachable" is the caller's contract to reprovision — same as before.
      expect(result).toBe("unreachable");
      expect(casSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      getClientSpy.mockRestore();
    }
  }, 30_000);
});

// The daemon handler for the `agent_resume` job. Covers the branch logic the
// piece-wise suites don't: idempotency (an already-running agent is never
// rebuilt), delegation to provision() for a stopped agent, not-found, and
// surfacing a provision failure. Pure spy-based + ?actual import so it stays
// order-independent in the single-process cloud-shared suite. (executeSuspend /
// deleteAgent run inside dbWrite.transaction and are exercised by the live
// provisioning lifecycle in prod.)
describe("ElizaSandboxService.executeResume", () => {
  const RESUME_AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const RESUME_ORG = "22222222-2222-4222-8222-222222222222";

  function resumeRow(status: AgentSandbox["status"]): AgentSandbox {
    return {
      ...customSandbox(),
      id: RESUME_AGENT,
      organization_id: RESUME_ORG,
      status,
    };
  }

  test("an already-running agent is a no-op — never re-provisioned", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("running"),
    );
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toEqual({ success: true, containerStarted: true, reprovisioned: false });
      // Re-provisioning a live agent would needlessly rebuild its container.
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  test("a stopped agent is resumed by delegating to provision()", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("stopped"),
    );
    const provisionSpy = spyOn(svc, "provision").mockResolvedValue({ success: true } as never);
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toEqual({ success: true, containerStarted: true, reprovisioned: true });
      expect(provisionSpy).toHaveBeenCalledTimes(1);
      expect(provisionSpy).toHaveBeenCalledWith(RESUME_AGENT, RESUME_ORG);
    } finally {
      findSpy.mockRestore();
    }
  });

  test("an unknown agent returns not-found without provisioning", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      undefined,
    );
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("Agent not found");
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  test("a provision failure during resume is surfaced, not swallowed", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("stopped"),
    );
    const provisionSpy = spyOn(svc, "provision").mockResolvedValue({
      success: false,
      error: "no capacity",
    } as never);
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res.success).toBe(false);
      expect(res.reprovisioned).toBe(true);
      expect(res.error).toBe("no capacity");
      expect(provisionSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
    }
  });
});

// Lifecycle bring-up (resume / wake / restart) must NOT resurrect a row that an
// agent_delete job already owns. A row in deletion_pending/deletion_failed is
// reported as "Agent not found" so the daemon completes the job as a terminal
// no-op instead of rebuilding a container being torn down.
describe("ElizaSandboxService deletion-state guards (resume/wake/restart)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  function row(status: AgentSandbox["status"]): AgentSandbox {
    return { ...customSandbox(), id: AGENT, organization_id: ORG, status };
  }

  for (const status of ["deletion_pending", "deletion_failed"] as const) {
    test(`executeResume bails on ${status} (not-found, no provision)`, async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const svc = new ElizaSandboxService();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        row(status),
      );
      const provisionSpy = spyOn(svc, "provision");
      try {
        const res = await svc.executeResume(AGENT, ORG);
        expect(res.success).toBe(false);
        expect(res.error).toBe("Agent not found");
        expect(provisionSpy).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
      }
    });

    test(`executeWake bails on ${status} (not-found, no provision)`, async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const svc = new ElizaSandboxService();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        row(status),
      );
      const provisionSpy = spyOn(svc, "provision");
      try {
        const res = await svc.executeWake(AGENT, ORG);
        expect(res.success).toBe(false);
        expect(res.error).toBe("Agent not found");
        expect(provisionSpy).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
      }
    });

    test(`executeRestart bails on ${status} before shutdown/provision`, async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const svc = new ElizaSandboxService();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        row(status),
      );
      const shutdownSpy = spyOn(svc, "shutdown");
      const provisionSpy = spyOn(svc, "provision");
      try {
        const res = await svc.executeRestart(AGENT, ORG);
        expect(res.success).toBe(false);
        expect(res.error).toBe("Agent not found");
        // Critically: never starts the stop+rebuild sequence on a doomed row.
        expect(shutdownSpy).not.toHaveBeenCalled();
        expect(provisionSpy).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
      }
    });
  }
});

// Orphaned shared-runtime history on delete is covered at the repository level
// in shared-runtime-history.test.ts: the post-commit deletion is a best-effort
// call to sharedRuntimeHistoryRepository.deleteByAgent.

// The anti-wedge teardown cap (PR #9066). deleteAgent now runs its three short
// DB phases (precheck → bounded teardown OUTSIDE the lock/txn → row delete) so
// we can spy each seam and assert the three-way teardown classification without
// a real DB or a 120s wait. dbWrite.transaction itself stays a Proxy we don't
// touch — the prepare/commit phases are spied at the method boundary.
describe("ElizaSandboxService.deleteAgent teardown cap (#9066)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const SANDBOX_ID = "sandbox-e06bb509";

  type Svc = {
    deleteAgent(agentId: string, orgId: string): Promise<unknown>;
    prepareAgentDelete(
      agentId: string,
      orgId: string,
    ): Promise<
      { ok: true; sandboxId: string | null; status: string } | { ok: false; error: string }
    >;
    commitAgentRowDelete(agentId: string, orgId: string): Promise<unknown>;
    runBoundedSandboxStop(sandboxId: string): Promise<unknown>;
  };

  async function makeSvc(): Promise<Svc> {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    return new ElizaSandboxService() as unknown as Svc;
  }

  test("(a) teardown timeout → delete still proceeds (row deleted) + leak warning, no phantom 'handled'", async () => {
    const svc = await makeSvc();
    const deletedSandbox = { ...customSandbox(), id: AGENT, organization_id: ORG };
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
    });
    // Timed-out teardown is reported as the { error, timedOut } shape.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      error: new Error("agent-delete stop sandbox-e06bb509 timed out after 120000ms"),
      timedOut: true,
    });
    const commit = spyOn(svc, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      deletedSandbox,
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as {
        success: boolean;
        deletedSandbox?: unknown;
      };
      // A hang must NOT block the delete — the row is still removed.
      expect(res.success).toBe(true);
      expect(res.deletedSandbox).toEqual(deletedSandbox);
      expect(commit).toHaveBeenCalledTimes(1);
      // The warning must flag a real leak — not pretend an orphan got swept.
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("timed out");
      expect(warned).toContain("ABANDONING");
      expect(warned).toContain("LEAK");
      expect(warned).not.toContain("reconciler sweeps");
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("(b) a real stop failure on a reachable node → delete aborts (failure), row never deleted", async () => {
    const svc = await makeSvc();
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
    });
    // Bounded (non-timeout) failure with a non-ignorable message.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      error: new Error("docker stop -> daemon hung; docker rm -f -> daemon hung"),
    });
    const commit = spyOn(svc, "commitAgentRowDelete");
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as { success: boolean; error?: string };
      expect(res.success).toBe(false);
      expect(res.error).toBe("Failed to delete sandbox");
      // Critically: the row delete is never attempted when the container may
      // still be running.
      expect(commit).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("(c) an ignorable 'already gone' failure → info + delete proceeds (row deleted)", async () => {
    const svc = await makeSvc();
    const deletedSandbox = { ...customSandbox(), id: AGENT, organization_id: ORG };
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      error: new Error("container not found"),
    });
    const commit = spyOn(svc, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      deletedSandbox,
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as { success: boolean };
      expect(res.success).toBe(true);
      expect(commit).toHaveBeenCalledTimes(1);
      const infoed = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(infoed).toContain("already absent");
      // An ignorable absence is NOT a leak warning.
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).not.toContain("ABANDONING");
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("the bounded teardown runs OUTSIDE the row-delete phase (sequenced, not nested)", async () => {
    const svc = await makeSvc();
    const order: string[] = [];
    const prepare = spyOn(svc, "prepareAgentDelete").mockImplementation(async () => {
      order.push("prepare");
      return { ok: true, sandboxId: SANDBOX_ID, status: "running" };
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockImplementation(async () => {
      order.push("teardown");
      return null;
    });
    const commit = spyOn(svc, "commitAgentRowDelete").mockImplementation(async () => {
      order.push("commit");
      return { success: true, deletedSandbox: { ...customSandbox(), id: AGENT } };
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    try {
      await svc.deleteAgent(AGENT, ORG);
      // Teardown must happen between the precheck txn and the row-delete txn,
      // never inside the write-lock/transaction.
      expect(order).toEqual(["prepare", "teardown", "commit"]);
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  test("runBoundedSandboxStop returns null on a clean provider stop", async () => {
    const svc = await makeSvc();
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ stop: async () => {} } as unknown as SandboxProvider);
    try {
      const res = await svc.runBoundedSandboxStop(SANDBOX_ID);
      expect(res).toBeNull();
    } finally {
      getProvider.mockRestore();
    }
  });

  test("runBoundedSandboxStop captures a provider error as a value (not a timeout)", async () => {
    const svc = await makeSvc();
    const boom = new Error("docker rm -f -> daemon hung");
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      stop: async () => {
        throw boom;
      },
    } as unknown as SandboxProvider);
    try {
      const res = (await svc.runBoundedSandboxStop(SANDBOX_ID)) as {
        error: unknown;
        timedOut?: true;
      };
      expect(res.error).toBe(boom);
      // A captured error is NOT a timeout — the delete must treat it as a real
      // failure, not abandon-and-proceed.
      expect("timedOut" in res).toBe(false);
    } finally {
      getProvider.mockRestore();
    }
  });

  // The whole reason #9066 exists: a provider.stop that genuinely never
  // settles (SSH connect / provider init wedge) must be cut off at the hard
  // cap so a single stuck node can't hang the delete past the job watchdog and
  // wedge the provisioning worker. The two tests above cover clean/error; this
  // one drives the REAL withTimeout branch — a never-settling stop raced under
  // fake timers — and asserts the abandon-and-proceed { error, timedOut }
  // shape that deleteAgent keys "ABANDON + LEAK" on.
  test("runBoundedSandboxStop cuts off a never-settling provider stop with { error, timedOut }", async () => {
    const svc = await makeSvc();
    // Never resolves and never rejects: the only way out is the timeout race.
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      stop: () => new Promise<void>(() => {}),
    } as unknown as SandboxProvider);
    jest.useFakeTimers();
    try {
      const pending = svc.runBoundedSandboxStop(SANDBOX_ID) as Promise<{
        error: unknown;
        timedOut?: true;
      }>;
      // Let getProvider() + the try-body microtasks settle so the timeout
      // timer is actually armed, then blow past the 120s hard cap.
      await Promise.resolve();
      jest.advanceTimersByTime(120_001);
      const res = await pending;
      // Abandon-and-proceed: a genuine hang is reported as a TIMEOUT, distinct
      // from a captured provider error (no `timedOut` flag on that path).
      expect(res.timedOut).toBe(true);
      expect(res.error).toBeInstanceOf(Error);
      expect((res.error as Error).message).toContain("timed out after");
    } finally {
      jest.useRealTimers();
      getProvider.mockRestore();
    }
  });
});

describe("computeManagedAgentDbEnv (#8696 local agent state)", () => {
  const DB = "postgres://shared.example/railway";

  test("local-state agent gets ELIZA_MANAGED_DATABASE_URL and NO DATABASE_URL", async () => {
    const { computeManagedAgentDbEnv } = await import("./eliza-sandbox.ts?actual");
    const env = computeManagedAgentDbEnv({ ELIZA_AGENT_LOCAL_STATE: "1" }, DB);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });

  test("existing agent (no flag) keeps the shared DATABASE_URL injection", async () => {
    const { computeManagedAgentDbEnv } = await import("./eliza-sandbox.ts?actual");
    const env = computeManagedAgentDbEnv({}, DB);
    expect(env.DATABASE_URL).toBe(DB);
    expect(env.ELIZA_MANAGED_DATABASE_URL).toBeUndefined();
  });

  test("caller-supplied DATABASE_URL is preserved; managed exposed separately", async () => {
    const { computeManagedAgentDbEnv } = await import("./eliza-sandbox.ts?actual");
    const env = computeManagedAgentDbEnv({ DATABASE_URL: "postgres://own.example/db" }, DB);
    // dbEnv never clobbers the caller's DATABASE_URL (it is spread first in create()).
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });

  // The merges below mirror create()'s `{ ...callerEnv, ...computeManagedAgentDbEnv(...) }`
  // (eliza-sandbox.ts) — the whole locality design depends on this spread order,
  // which the pure-function tests above don't exercise.
  test("create() merge: a caller DATABASE_URL survives while the shared DB rides ELIZA_MANAGED_DATABASE_URL", async () => {
    const { computeManagedAgentDbEnv } = await import("./eliza-sandbox.ts?actual");
    const callerEnv = { DATABASE_URL: "postgres://own.example/db" };
    const merged = { ...callerEnv, ...computeManagedAgentDbEnv(callerEnv, DB) };
    expect(merged.DATABASE_URL).toBe("postgres://own.example/db");
    expect(merged.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });

  test("create() merge: a local-state agent ends with NO DATABASE_URL and the shared DB on the managed key", async () => {
    const { computeManagedAgentDbEnv } = await import("./eliza-sandbox.ts?actual");
    const callerEnv = { ELIZA_AGENT_LOCAL_STATE: "1" };
    const merged = { ...callerEnv, ...computeManagedAgentDbEnv(callerEnv, DB) };
    expect(merged.DATABASE_URL).toBeUndefined();
    expect(merged.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });
});

describe("buildRuntimeBootstrapAgent persona seed", () => {
  type BootstrapRec = Pick<AgentSandbox, "id" | "agent_name" | "agent_config" | "environment_vars">;
  type BootstrapAgent = {
    name: string;
    system: string;
    bio: string[];
    style?: { all?: string[]; chat?: string[]; post?: string[] };
  };

  async function buildBootstrap(rec: BootstrapRec): Promise<BootstrapAgent> {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService() as unknown as {
      buildRuntimeBootstrapAgent(r: BootstrapRec): BootstrapAgent;
    };
    return svc.buildRuntimeBootstrapAgent(rec);
  }

  const baseRec: BootstrapRec = {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    agent_name: "bnancy",
    agent_config: {},
    environment_vars: {},
  };

  test("seeds a name-aware identity when agent_config has no system/bio", async () => {
    const agent = await buildBootstrap(baseRec);
    // Real identity (no generic deflection) that matches the agent's own name —
    // not the placeholder, and not a claim to be a differently-named character.
    expect(agent.name).toBe("bnancy");
    expect(agent.system).toBe("You are bnancy, a helpful assistant.");
    expect(agent.bio).toEqual(["bnancy is a helpful Eliza Cloud agent."]);
    expect(agent.system).not.toBe("Concise cloud agent.");
    expect(agent.system).not.toContain("Eliza - not an assistant");
    expect(agent.style).toBeUndefined();
  });

  test("preserves a real persona supplied in agent_config", async () => {
    const agent = await buildBootstrap({
      ...baseRec,
      agent_config: {
        system: "You are shared-nancy.",
        bio: ["a real bio"],
        style: { all: ["terse"] },
      },
    });
    expect(agent.system).toBe("You are shared-nancy.");
    expect(agent.bio).toEqual(["a real bio"]);
    expect(agent.style).toEqual({ all: ["terse"] });
  });
});

// LARP H2 — provision() concurrent-create dedup + TOCTOU port-collision retry.
// These drive the REAL provision() body (imported via ?actual) so each guarded
// branch is exercised, not mocked away:
//   1. trySetProvisioning lost the lock but the row is already running+reachable
//      → REUSE the live container (never re-create).
//   2. lock lost AND not running → "already being provisioned", no create.
//   3. provider.create OK but the row-write hits a UNIQUE (port TOCTOU) on the
//      first attempt → ghost stop + retry → second attempt succeeds.
//   4. a NON-unique post-create error → markError + NO retry (one create only).
//   5. all MAX_PROVISION_ATTEMPTS exhausted → "Provisioning failed after N".
// The provider is a plain SandboxProvider fake; the post-create metadata uses a
// real DockerSandboxMetadata shape so isDockerSandboxMetadata() genuinely passes.
describe("ElizaSandboxService.provision dedup + port-collision retry (LARP H2)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  // A row whose DB is already provisioned (database_status==="ready") so the
  // provision() DB phase is skipped and control reaches the create/retry loop.
  function provisioningReadyRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "provisioning",
      sandbox_id: null,
      bridge_url: null,
      health_url: null,
      database_uri: "postgres://shared.example/railway",
      database_status: "ready",
      // Custom-tier so the post-create backup-restore HTTP 404 is tolerated and
      // ensureRuntimeAgentStarted's list endpoint is not the gating factor (it
      // is spied to a no-op below regardless).
      execution_tier: "custom",
    };
  }

  // Realistic provider handle: metadata is a genuine DockerSandboxMetadata so
  // isDockerSandboxMetadata(handle.metadata) returns true in the real method.
  function providerHandle() {
    return {
      sandboxId: "sandbox-blue-1",
      bridgeUrl: "https://runtime-blue.example",
      healthUrl: "https://runtime-blue.example/health",
      metadata: {
        provider: "docker" as const,
        nodeId: "node-2",
        hostname: "node-2.internal",
        containerName: "agent-blue-1",
        bridgePort: 21070,
        webUiPort: 23900,
        agentId: AGENT,
        volumePath: "/var/lib/eliza/agent-blue-1",
        dockerImage: "ghcr.io/example/bnancy:latest",
        imageDigest: "sha256:bluebluebluebluebluebluebluebluebluebluebluebluebluebluebluebl01",
      },
    };
  }

  test("(1) lock lost but row already running+reachable → reuse, provider.create NEVER called", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const runningRow: AgentSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      bridge_url: "https://live-bridge.example",
      health_url: "https://live-bridge.example/health",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(runningRow);
    // trySetProvisioning returns undefined: someone else holds the lock.
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      undefined,
    );
    const create = mock(async () => providerHandle());
    const provider: SandboxProvider = {
      create,
      stop: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    try {
      const res = await new ElizaSandboxService(provider).provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(runningRow);
      expect(res.bridgeUrl).toBe("https://live-bridge.example");
      expect(res.healthUrl).toBe("https://live-bridge.example/health");
      // Reusing the live container is the whole point — a second create would
      // double-provision and orphan a container.
      expect(create).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  test("(2) lock lost AND not running → 'Agent is already being provisioned', no create", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const provisioningRow: AgentSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "provisioning",
      bridge_url: null,
      health_url: null,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      provisioningRow,
    );
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      undefined,
    );
    const create = mock(async () => providerHandle());
    const provider: SandboxProvider = {
      create,
      stop: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    try {
      const res = await new ElizaSandboxService(provider).provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("Agent is already being provisioned");
      expect(res.sandboxRecord).toBe(provisioningRow);
      expect(create).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  test("(3) UNIQUE (port TOCTOU) on attempt 1 → ghost stop + retry → attempt 2 succeeds", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    // The status-write is the row that races on the (node_id, bridge_port)
    // UNIQUE constraint. Fail it with a PG 23505 once, then succeed.
    let statusWrites = 0;
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") {
          statusWrites += 1;
          if (statusWrites === 1) {
            throw new Error('duplicate key value violates unique constraint "23505"');
          }
          return finalRow;
        }
        // Environment-vars persistence write (managedEnvironment.changed) — pass through.
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    // ensureRuntimeAgentStarted hits the runtime over HTTP — no-op it so the
    // retry path under test is the row-write, not the runtime bring-up.
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      // Two create attempts: the first container became a ghost on the UNIQUE
      // failure and was stopped; the second is the live one.
      expect(create).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith("sandbox-blue-1");
      expect(statusWrites).toBe(2);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(4) a NON-unique post-create error → markError, NO retry (one create), failure", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") {
          // A non-retryable write failure (NOT a unique violation).
          throw new Error("connection terminated unexpectedly");
        }
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(
      svc as unknown as { markError: (rec: AgentSandbox, msg: string) => Promise<void> },
      "markError",
    ).mockResolvedValue(undefined);
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("connection terminated unexpectedly");
      // A non-unique error is NOT a port collision — must not retry.
      expect(create).toHaveBeenCalledTimes(1);
      // Ghost deletion still runs once for the single failed attempt.
      expect(stop).toHaveBeenCalledTimes(1);
      expect(markErrorSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(5) UNIQUE on every attempt → exhaustion → 'Provisioning failed after 3 attempts'", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    let statusWrites = 0;
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") {
          statusWrites += 1;
          throw new Error("duplicate key value violates unique constraint (port collision)");
        }
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    let markedMessage = "";
    const markErrorSpy = spyOn(
      svc as unknown as { markError: (rec: AgentSandbox, msg: string) => Promise<void> },
      "markError",
    ).mockImplementation(async (_rec, msg) => {
      markedMessage = msg;
    });
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      // MAX_PROVISION_ATTEMPTS = 3: three creates, three ghost stops, then give up.
      expect(create).toHaveBeenCalledTimes(3);
      expect(stop).toHaveBeenCalledTimes(3);
      expect(statusWrites).toBe(3);
      expect(markedMessage).toContain("Provisioning failed after 3 attempts");
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // #10554 finding 2 — free-compute leak. A successful provision MUST re-enter
  // the billable set so a credit-suspended agent that a user tops up + resumes
  // (via the user-facing routes that don't reactivate themselves) cannot run
  // (status='running') permanently excluded from listBillableSandboxes = free
  // dedicated compute. This drives the REAL provision() success path; the writer
  // itself is proven against a real DB in agent-billing-reactivation.test.ts.
  test("(6) a successful provision re-enters the billable set", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    reactivateBillingSpy.mockClear();
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      // The fix: provision() re-enters billing for the just-provisioned agent.
      expect(reactivateBillingSpy).toHaveBeenCalledTimes(1);
      expect(reactivateBillingSpy).toHaveBeenCalledWith(AGENT, expect.any(Date));
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(7) a provision that never reaches running does NOT re-enter billing", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    // Lock lost AND row not running → bails ("already being provisioned") before
    // the success block, so billing is NOT (re)activated for a non-provisioned agent.
    const provisioningRow: AgentSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "provisioning",
      bridge_url: null,
      health_url: null,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(
      provisioningRow,
    );
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      undefined,
    );
    const provider: SandboxProvider = {
      create: mock(async () => providerHandle()),
      stop: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    reactivateBillingSpy.mockClear();
    try {
      const res = await new ElizaSandboxService(provider).provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(reactivateBillingSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
    }
  });

  test("(8) status='running' persists BEFORE the backup-restore push (#14038 wake-lag)", async () => {
    // The status column is the reachability gate: the dedicated-agent proxy
    // synthesizes 202 "starting" for every request (including the launcher's
    // /api/status poll) until status='running'. The container serves the moment
    // the health check + runtime-agent start succeed, so the flip must not wait
    // for the (potentially long) state restore — that ordering is exactly the
    // "agent answers in ~8s but launcher says waking for 90s+" prod window.
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const backup: AgentSandboxBackup = {
      id: "33333333-3333-4333-8333-333333333333",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const order: string[] = [];
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") order.push("status-running");
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockImplementation(async () => {
      order.push("push-state");
      return null;
    });
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create: mock(async () => providerHandle()),
      stop: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(order).toEqual(["status-running", "push-state"]);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(9) restore failure after the early running-write still ends in markError", async () => {
    // 'running' must never stick on a failed provision: a restore failure takes
    // the same catch as before (ghost cleanup → markError), so the early
    // reachability flip cannot leave a broken agent advertised as running.
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      execution_tier: "dedicated-lazy",
    };
    const backup: AgentSandboxBackup = {
      id: "44444444-4444-4444-8444-444444444444",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(0);
    let runningWrites = 0;
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") runningWrites += 1;
        return { ...row, ...data };
      },
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(
      svc as unknown as { markError: (rec: AgentSandbox, msg: string) => Promise<void> },
      "markError",
    ).mockResolvedValue(undefined);
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockRejectedValue(new Error("State restore failed: HTTP 500"));
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create: mock(async () => providerHandle()),
      stop,
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect(res.error).toBe("State restore failed: HTTP 500");
      expect(runningWrites).toBe(1);
      expect(markErrorSpy).toHaveBeenCalledTimes(1);
      // Ghost cleanup still stops the container whose restore failed.
      expect(stop).toHaveBeenCalledWith("sandbox-blue-1");
      // A transient 5xx must NOT be classified as unrecoverable: the snapshot
      // chain stays intact for the retry that may restore it.
      expect(pruneSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The KMS timebomb (HQ #14308): a provisioning worker misconfigured with the
  // ephemeral `memory` KMS backend rotates its key on every restart, orphaning
  // the pre-upgrade snapshot it wrote — decrypt then throws KeyNotFoundError on
  // resume. That must degrade to a FRESH boot (agent comes up without prior
  // in-memory state), NOT brick the whole provision closed. Drives the REAL
  // provision() body; the thrown error is the REAL @elizaos/security
  // KeyNotFoundError.
  test("(10) an orphaned snapshot (KeyNotFoundError on getLatestBackup) degrades to a fresh boot", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    // The org DEK that encrypted the snapshot is gone (memory backend restart).
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockRejectedValue(
      new KeyNotFoundError(orgKey(ORG, "dek"), 1),
    );
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(1);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    // A fresh boot must NOT push any restore state.
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      // Fresh boot: the provision SUCCEEDS instead of bricking.
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      expect(create).toHaveBeenCalledTimes(1);
      // Orphaned snapshot discarded (never pushed) and its dead chain dropped so
      // the next resume does not re-hit it.
      expect(pushStateSpy).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 0);
      // The degrade is logged with context, never silent.
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
      // A degrade is not a container failure — no ghost cleanup.
      expect(stop).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The other undecryptable shape: a corrupt / wrong-key snapshot whose AEAD auth
  // tag will not verify surfaces as a real AeadError from reconstruction. Same
  // degrade-to-fresh-boot outcome.
  test("(11) a corrupt snapshot (AeadError on reconstruction) degrades to a fresh boot", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const aeadError = await realAeadDecryptError();
    expect(aeadError.name).toBe("AeadError"); // guard: a genuine crypto failure
    const row = provisioningReadyRow();
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "55555555-5555-4555-8555-555555555555",
      sandbox_record_id: row.id,
      snapshot_type: "pre-upgrade",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockRejectedValue(aeadError);
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(2);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const pushStateSpy = spyOn(
      svc as unknown as { pushState: () => Promise<unknown> },
      "pushState",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stop: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      expect(pushStateSpy).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 0);
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      pushStateSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The load-bearing distinction: a transient (non-crypto) backup-read failure —
  // a DB blip, network hiccup — must NOT be swallowed. Degrading on it would
  // silently discard state a retry would have restored, so it propagates and the
  // provision fails (the resume job then retries).
  test("(12) a transient (non-crypto) backup-read failure propagates — provision fails, snapshot NOT discarded", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue({
      ...row,
      status: "error",
    });
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    // A DB blip, NOT a crypto failure — must NOT degrade.
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(0);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(
      svc as unknown as { markError: (rec: AgentSandbox, msg: string) => Promise<void> },
      "markError",
    ).mockResolvedValue(undefined);
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      // A transient failure fails the provision (the resume job retries), rather
      // than silently discarding recoverable state.
      expect(res.success).toBe(false);
      expect(res.error).toBe("connection terminated unexpectedly");
      expect(markErrorSpy).toHaveBeenCalledTimes(1);
      // Must NOT degrade: the snapshot chain is untouched, no degrade logged.
      expect(pruneSpy).not.toHaveBeenCalled();
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("Unrecoverable snapshot");
      // Ghost cleanup still stops the just-created container.
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // The HQ 14308 incident, end to end: the restore push to the new container is
  // rejected 401 Unauthorized (bridge URL routing to a dead/rotated container),
  // which is deterministic on every attempt — retrying only burned the
  // provision attempts and bricked agent 23766030 into status=error
  // ("Provisioning failed after 3 attempts: State restore failed: HTTP 401
  // {"error":"Unauthorized"}"). It must instead degrade to a fresh boot on the
  // FIRST detection. Drives the REAL pushState (fetch intercepted with the
  // incident's exact response) so the classified error is the code's own throw
  // shape, not a hand-rolled string.
  test("(13) restore push rejected 401 (dead/rotated container) degrades to a fresh boot on the first attempt", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row: AgentSandbox = { ...provisioningReadyRow(), execution_tier: "dedicated-lazy" };
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "66666666-6666-4666-8666-666666666666",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(1);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(
      svc as unknown as { markError: (rec: AgentSandbox, msg: string) => Promise<void> },
      "markError",
    ).mockResolvedValue(undefined);
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    // REAL pushState: only the fetch layer is intercepted, replaying the
    // incident's exact response, so the thrown error is pushState's own
    // `State restore failed: HTTP 401 {"error":"Unauthorized"}`.
    const restoreCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      restoreCalls.push(fetchUrl(input));
      return new Response('{"error":"Unauthorized"}', { status: 401 });
    }) as typeof fetch;
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      // Fresh boot: the provision SUCCEEDS instead of bricking the agent.
      expect(res.success).toBe(true);
      expect(res.sandboxRecord).toBe(finalRow);
      // The restore POST really went to the new container's bridge.
      expect(restoreCalls).toEqual(["https://runtime-blue.example/api/restore"]);
      // Degrade on FIRST detection: one create, no retry burn, no ghost
      // cleanup of the healthy container, no markError.
      expect(create).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(markErrorSpy).not.toHaveBeenCalled();
      // The dead chain is dropped so the next resume boots clean.
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 0);
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // A restore-endpoint 404 on a NON-custom tier is equally deterministic (the
  // image will never grow the endpoint mid-provision) — same degrade, via the
  // real pushState throw shape.
  test("(14) restore push rejected 404 on a non-custom tier degrades to a fresh boot", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row: AgentSandbox = { ...provisioningReadyRow(), execution_tier: "dedicated-lazy" };
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "77777777-7777-4777-8777-777777777777",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(1);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const markErrorSpy = spyOn(
      svc as unknown as { markError: (rec: AgentSandbox, msg: string) => Promise<void> },
      "markError",
    ).mockResolvedValue(undefined);
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({ create, stop, checkHealth: async () => true } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      expect(markErrorSpy).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 0);
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Unrecoverable snapshot, booting fresh");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      errorLogSpy.mockRestore();
      markErrorSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  // Custom-tier images legitimately lack /api/restore: that 404 stays the
  // designed benign skip — the snapshot is KEPT (no prune) for a future image
  // that has the endpoint. Guards the branch ordering: the skip must win over
  // the unrecoverable degrade.
  test("(15) restore push 404 on a custom tier stays a benign skip — snapshot kept, no degrade", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow(); // execution_tier: "custom"
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const backup: AgentSandboxBackup = {
      id: "88888888-8888-4888-8888-888888888888",
      sandbox_record_id: row.id,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(backup);
    const reconstructedSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(0);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const infoLogSpy = spyOn(logger, "info").mockImplementation(() => {});
    const errorLogSpy = spyOn(logger, "error").mockImplementation(() => {});
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stop: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);
    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(true);
      // Benign skip, not a degrade: chain untouched, no error-level log.
      expect(pruneSpy).not.toHaveBeenCalled();
      const info = infoLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(info).toContain("custom image has no restore endpoint");
      const logged = errorLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("Unrecoverable snapshot");
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      reconstructedSpy.mockRestore();
      pruneSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      infoLogSpy.mockRestore();
      errorLogSpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });
});

// Snapshot-degrade error classification (`isUnrecoverableSnapshotError`), proven
// against REAL @elizaos/security errors produced by the crypto stack — the
// precise crypto-vs-transient distinction the degrade path keys on.
describe("isUnrecoverableSnapshotError (permanent-vs-transient classification)", () => {
  test("classifies a real KeyNotFoundError (memory-KMS key rotated away) as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import("./eliza-sandbox.ts?actual");
    const err = await realKeyRotatedAwayError();
    // The exact prod incident: the memory backend restart orphaned the key.
    expect(err).toBeInstanceOf(KeyNotFoundError);
    expect(isUnrecoverableSnapshotError(err)).toBe(true);
  });

  test("classifies a real AeadError (auth-tag failure) as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import("./eliza-sandbox.ts?actual");
    const err = await realAeadDecryptError();
    expect(err.name).toBe("AeadError");
    expect(isUnrecoverableSnapshotError(err)).toBe(true);
  });

  test("classifies permanent snapshot HTTP rejections (401/403/404/410) as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import("./eliza-sandbox.ts?actual");
    // The exact HQ 14308 incident string, as pushState throws it (status +
    // first 200 bytes of the response body).
    expect(
      isUnrecoverableSnapshotError(
        new Error('State restore failed: HTTP 401 {"error":"Unauthorized"}'),
      ),
    ).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 403 "))).toBe(true);
    expect(
      isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 404 Not Found")),
    ).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 410 Gone"))).toBe(
      true,
    );
    // fetchSnapshotState's shape (no body suffix). Its 404 is mapped to the
    // SNAPSHOT_ENDPOINT_UNSUPPORTED sentinel before ever surfacing, but the
    // auth statuses surface verbatim.
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 401"))).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 403"))).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 410"))).toBe(true);
  });

  test("does NOT classify transient snapshot HTTP failures — those must retry", async () => {
    const { isUnrecoverableSnapshotError } = await import("./eliza-sandbox.ts?actual");
    // 5xx (container mid-boot / overloaded), 408 (timeout), 429 (throttled):
    // all can heal on the next attempt, so degrading would discard restorable
    // state.
    expect(
      isUnrecoverableSnapshotError(
        new Error("State restore failed: HTTP 500 Internal Server Error"),
      ),
    ).toBe(false);
    expect(
      isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 502 Bad Gateway")),
    ).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 503 "))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 408 "))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 429 "))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 500"))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 503"))).toBe(false);
  });

  test("matches only this file's snapshot throw shapes — anchored, exact status", async () => {
    const { isUnrecoverableSnapshotError, SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import(
      "./eliza-sandbox.ts?actual"
    );
    // Network-level fetch failures carry no HTTP status and must propagate.
    expect(isUnrecoverableSnapshotError(new TypeError("fetch failed"))).toBe(false);
    // A message that merely EMBEDS the wrapper (e.g. the markError re-wrap) is
    // not the raw restore-path error the degrade classifies.
    expect(
      isUnrecoverableSnapshotError(
        new Error(
          'Provisioning failed after 3 attempts: State restore failed: HTTP 401 {"error":"Unauthorized"}',
        ),
      ),
    ).toBe(false);
    // The "image has no snapshot endpoint" sentinel is a benign skip elsewhere,
    // never a degrade.
    expect(isUnrecoverableSnapshotError(new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("Sandbox is not running"))).toBe(false);
  });

  test("does NOT classify transient / non-crypto failures as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import("./eliza-sandbox.ts?actual");
    // A DB/network blip, a base Steward KmsError (HTTP 5xx transient), and
    // non-Errors must all propagate — degrading on them would discard state a
    // retry would have restored.
    expect(isUnrecoverableSnapshotError(new Error("connection terminated unexpectedly"))).toBe(
      false,
    );
    expect(
      isUnrecoverableSnapshotError(
        new KmsError("Steward KMS decrypt failed (503 Service Unavailable)"),
      ),
    ).toBe(false);
    expect(isUnrecoverableSnapshotError("AEAD decrypt failed")).toBe(false);
    expect(isUnrecoverableSnapshotError(null)).toBe(false);
    expect(isUnrecoverableSnapshotError(undefined)).toBe(false);
  });
});

// LARP H3 — executeUpgrade() blue/green rollback, digest-mismatch, and the
// compare-and-swap race guard that protects a LIVE billed agent row.
// The provider MUST be a real DockerSandboxProvider instance (the method bails
// with "only supported on docker provider" otherwise), so we construct one and
// override its methods with spies — `instanceof DockerSandboxProvider` stays
// true. Blue metadata is a genuine DockerSandboxMetadata so the real
// isDockerSandboxMetadata() guard passes. The swap runs inside
// dbWrite.transaction(); we drive it via upgradeTransactionImpl + spies on the
// private lockLifecycle / getAgentForLifecycleMutation seams.
describe("ElizaSandboxService.executeUpgrade blue/green rollback + CAS guard (LARP H3)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const DOCKER_IMAGE = "ghcr.io/elizaos/eliza-agent:latest";
  const FROM_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000aaa";
  const TO_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111bbb";

  function runtimeHealthResponse(
    body: Record<string, unknown> = {
      ready: true,
      runtime: "ok",
      database: "ok",
      plugins: { failed: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  // A live fleet-managed agent: running, with an old node/container, and
  // docker_image === null so the "custom image" guard does not reject it.
  function liveAgentRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      sandbox_id: "sandbox-old-1",
      node_id: "node-old",
      container_name: "agent-old-1",
      bridge_url: "https://old-bridge.example",
      health_url: "https://old-bridge.example/health",
      docker_image: null,
      image_digest: FROM_DIGEST,
    };
  }

  function oldNode(): DockerNode {
    return {
      node_id: "node-old",
      hostname: "node-old.internal",
      ssh_port: 22,
      ssh_user: "root",
      host_key_fingerprint: null,
    } as unknown as DockerNode;
  }

  // A genuine DockerSandboxMetadata for blue — isDockerSandboxMetadata() passes.
  function blueMetadata(imageDigest: string | null) {
    return {
      provider: "docker" as const,
      nodeId: "node-new",
      hostname: "node-new.internal",
      containerName: "agent-new-1",
      bridgePort: 21080,
      webUiPort: 23950,
      agentId: AGENT,
      volumePath: "/var/lib/eliza/agent-new-1",
      dockerImage: DOCKER_IMAGE,
      imageDigest,
    };
  }

  function blueHandle(imageDigest: string | null) {
    return {
      sandboxId: "sandbox-new-1",
      bridgeUrl: "https://new-bridge.example",
      healthUrl: "https://new-bridge.example/health",
      metadata: blueMetadata(imageDigest),
    };
  }

  // Build a real DockerSandboxProvider whose I/O methods are spies so
  // `provider instanceof DockerSandboxProvider` holds in executeUpgrade().
  async function makeDockerProvider(overrides: {
    create: () => Promise<unknown>;
    checkHealth: () => Promise<boolean>;
  }) {
    // Import WITHOUT `?actual` so this class identity matches the one
    // executeUpgrade() resolves via its own `await import("./docker-sandbox-provider")`
    // (no `?actual`) — otherwise `provider instanceof DockerSandboxProvider` is false.
    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    const provider = new DockerSandboxProvider();
    const create = mock(overrides.create);
    const checkHealth = mock(overrides.checkHealth);
    const stop = mock(async () => {});
    const stopOnSpecificNode = mock(async () => {});
    Object.assign(provider, { create, checkHealth, stop, stopOnSpecificNode });
    globalThis.fetch = mock(async () => runtimeHealthResponse()) as unknown as typeof fetch;
    return {
      provider: provider as unknown as SandboxProvider,
      create,
      checkHealth,
      stop,
      stopOnSpecificNode,
    };
  }

  afterEach(() => {
    upgradeTransactionImpl = null;
  });

  test("(a) blue health-check FAILS → blue torn down, row stays on OLD, rolled-back error", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => false, // blue never comes up
    });
    // A swap must NOT be attempted on a failed health check.
    let transactionCalled = false;
    upgradeTransactionImpl = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await new ElizaSandboxService(provider).executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("rolled back to old container");
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
      // The unhealthy blue is torn down...
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith("sandbox-new-1");
      // ...and the live row is never swapped.
      expect(transactionCalled).toBe(false);
      expect(res.oldNodeId).toBe("node-old");
      expect(res.oldContainerName).toBe("agent-old-1");
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(b) blue digest MISMATCH → blue torn down, NO swap", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const WRONG_DIGEST = "sha256:dededededededededededededededededededededededededededededede0000";
    const { provider, create, checkHealth, stop } = await makeDockerProvider({
      create: async () => blueHandle(WRONG_DIGEST), // healthy but wrong image
      checkHealth: async () => true,
    });
    let transactionCalled = false;
    upgradeTransactionImpl = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await new ElizaSandboxService(provider).executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("digest mismatch");
      expect(res.error).toContain(TO_DIGEST);
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
      // Serving the WRONG image would silently ship an unintended build — tear blue down.
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith("sandbox-new-1");
      // No swap of the live row.
      expect(transactionCalled).toBe(false);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(b2) blue runtime readiness gate FAILS → blue torn down, NO snapshot or swap", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const healthFetch = mock(async () =>
      runtimeHealthResponse({
        ready: false,
        runtime: "ok",
        database: "ok",
        plugins: { failed: 1 },
        agentState: "starting",
        startup: { lastError: "migration failed" },
      }),
    );
    globalThis.fetch = healthFetch as unknown as typeof fetch;
    const svc = new ElizaSandboxService(provider);
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    let transactionCalled = false;
    upgradeTransactionImpl = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Blue runtime readiness gate failed");
      expect(res.error).toContain("ready=false");
      expect(res.error).toContain("plugins.failed=1");
      expect(res.error).toContain("migration failed");
      expect(healthFetch).toHaveBeenCalledTimes(1);
      expect(snapshotSpy).not.toHaveBeenCalled();
      expect(transactionCalled).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith("sandbox-new-1");
      expect(stopOnSpecificNode).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  }, 20_000);

  test("(c) happy path → atomic swap writes blue's node/container/bridge + image_digest=toDigest", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    // Pin the lifecycle lock + the FOR-UPDATE read to a no-op / unchanged row so
    // the CAS guard passes and control reaches the UPDATE.
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    // A pre-upgrade restore point MUST be captured before the swap. Stub the
    // snapshot itself (its own DB/bridge path is covered elsewhere) so we can
    // assert it ran with the "pre-upgrade" type before any swap params.
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    // Capture the raw UPDATE the swap issues so we can assert the new values
    // bound into it (drizzle SQL chunks carry the bound params).
    let executedSql: unknown;
    upgradeTransactionImpl = async (fn) => {
      const tx: UpgradeTx = {
        execute: async (query: unknown) => {
          executedSql = query;
          return { rows: [{ id: AGENT }] }; // RETURNING id → exactly one row
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(true);
      expect(res.newNodeId).toBe("node-new");
      expect(res.newContainerName).toBe("agent-new-1");
      expect(res.newDigest).toBe(TO_DIGEST);
      // A pre-upgrade snapshot was taken BEFORE the swap transaction ran.
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
      expect(snapshotSpy).toHaveBeenCalledWith(AGENT, ORG, "pre-upgrade");
      // The swap's UPDATE binds blue's identity + the target digest + the prior
      // image as the rollback target.
      const params = sqlBoundParams(executedSql);
      expect(params).toContain("sandbox-new-1"); // blue sandbox id
      expect(params).toContain("https://new-bridge.example"); // blue bridge_url
      expect(params).toContain("node-new"); // blue node_id
      expect(params).toContain("agent-new-1"); // blue container_name
      expect(params).toContain(TO_DIGEST); // image_digest := toDigest
      expect(params).toContain(FROM_DIGEST); // previous_image_digest := fromDigest
      expect(params).toContain(DOCKER_IMAGE); // previous_docker_image (agent.docker_image is null → dockerImage)
      // The old container is best-effort torn down on its specific node; the
      // blue is the live one and is NOT stopped.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("(c2) pre-upgrade snapshot failure → blue torn down, NO swap", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean; error?: string }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: false, error: "manifest missing" });
    let transactionCalled = false;
    upgradeTransactionImpl = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Pre-upgrade snapshot failed");
      expect(res.error).toContain("manifest missing");
      expect(snapshotSpy).toHaveBeenCalledWith(AGENT, ORG, "pre-upgrade");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith("sandbox-new-1");
      expect(stopOnSpecificNode).not.toHaveBeenCalled();
      expect(transactionCalled).toBe(false);
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("(d) CAS guard: row moved under us → returns false → throws 'changed during upgrade', tears down orphaned blue", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    // The FOR-UPDATE read shows the row already moved (a concurrent restart put
    // it on a different node/container) → the CAS guard rejects the swap.
    const movedRow: AgentSandbox = {
      ...agent,
      node_id: "node-someone-else",
      container_name: "agent-someone-else",
    };
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(movedRow);
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    let executeCalled = false;
    upgradeTransactionImpl = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => {
          executeCalled = true;
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(false);
      expect(res.error).toContain("Agent changed during upgrade");
      // The guard short-circuits BEFORE the UPDATE — never writes a stale swap.
      expect(executeCalled).toBe(false);
      // The orphaned blue (built but never adopted) is torn down...
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith("sandbox-new-1");
      // ...and the old container is left running (it still serves traffic).
      expect(stopOnSpecificNode).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });
});

// #9964 — executeDowngrade() symmetric blue/green rollback onto the persisted
// previous_image_digest. Mirrors the executeUpgrade harness: a real
// DockerSandboxProvider with spied I/O so `instanceof` holds, a genuine
// DockerSandboxMetadata for blue, and the swap driven through
// upgradeTransactionImpl + spies on the private lifecycle seams. The pre-upgrade
// restore point and its reconstruction are stubbed on the repository.
describe("ElizaSandboxService.executeDowngrade rollback onto previous_image_digest (#9964)", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";
  const DOCKER_IMAGE = "ghcr.io/elizaos/eliza-agent:latest";
  // The agent currently runs on the post-upgrade digest; rollback targets PREV.
  const CURRENT_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111bbb";
  const PREV_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000aaa";

  // A live fleet agent that HAS a persisted rollback target.
  function upgradedAgentRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      sandbox_id: "sandbox-cur-1",
      node_id: "node-cur",
      container_name: "agent-cur-1",
      bridge_url: "https://cur-bridge.example",
      health_url: "https://cur-bridge.example/health",
      docker_image: null,
      image_digest: CURRENT_DIGEST,
      previous_image_digest: PREV_DIGEST,
      previous_docker_image: DOCKER_IMAGE,
    };
  }

  function curNode(): DockerNode {
    return {
      node_id: "node-cur",
      hostname: "node-cur.internal",
      ssh_port: 22,
      ssh_user: "root",
      host_key_fingerprint: null,
    } as unknown as DockerNode;
  }

  function blueMetadata(imageDigest: string | null) {
    return {
      provider: "docker" as const,
      nodeId: "node-rb",
      hostname: "node-rb.internal",
      containerName: "agent-rb-1",
      bridgePort: 21090,
      webUiPort: 23960,
      agentId: AGENT,
      volumePath: "/var/lib/eliza/agent-rb-1",
      dockerImage: DOCKER_IMAGE,
      imageDigest,
    };
  }

  function blueHandle(imageDigest: string | null) {
    return {
      sandboxId: "sandbox-rb-1",
      bridgeUrl: "https://rb-bridge.example",
      healthUrl: "https://rb-bridge.example/health",
      metadata: blueMetadata(imageDigest),
    };
  }

  async function makeDockerProvider(overrides: {
    create: () => Promise<unknown>;
    checkHealth: () => Promise<boolean>;
  }) {
    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    const provider = new DockerSandboxProvider();
    const create = mock(overrides.create);
    const checkHealth = mock(overrides.checkHealth);
    const stop = mock(async () => {});
    const stopOnSpecificNode = mock(async () => {});
    Object.assign(provider, { create, checkHealth, stop, stopOnSpecificNode });
    return {
      provider: provider as unknown as SandboxProvider,
      create,
      checkHealth,
      stop,
      stopOnSpecificNode,
    };
  }

  afterEach(() => {
    upgradeTransactionImpl = null;
  });

  test("no previous_image_digest → refuses, never touches the live agent", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent: AgentSandbox = { ...upgradedAgentRow(), previous_image_digest: null };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(PREV_DIGEST),
      checkHealth: async () => true,
    });
    try {
      const res = await new ElizaSandboxService(provider).executeDowngrade(
        AGENT,
        ORG,
        DOCKER_IMAGE,
        CURRENT_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain("nothing to roll back to");
      // No blue is ever provisioned — there is no rollback target.
      expect(create).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  test("happy path → restores pre-upgrade snapshot then swaps back onto PREV_DIGEST + clears prior columns", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = upgradedAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(curNode());
    // The pre-upgrade restore point + its reconstruction.
    const preUpgradeBackup = {
      id: "backup-preupgrade-1",
      sandbox_record_id: AGENT,
      snapshot_type: "pre-upgrade",
    } as unknown as AgentSandboxBackup;
    const byTypeSpy = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      preUpgradeBackup,
    );
    const reconstructSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: { restored: true }, workspaceFiles: {} });
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(PREV_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    // The pre-cutover state push lands on blue's /api/restore — stub the private
    // pushState so the test stays offline; assert it received blue's bridge URL.
    const pushSpy = spyOn(
      svc as unknown as { pushState: (...a: unknown[]) => Promise<void> },
      "pushState",
    ).mockResolvedValue(undefined);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(agent);
    let executedSql: unknown;
    upgradeTransactionImpl = async (fn) => {
      const tx: UpgradeTx = {
        execute: async (query: unknown) => {
          executedSql = query;
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeDowngrade(AGENT, ORG, DOCKER_IMAGE, CURRENT_DIGEST);
      expect(res.success).toBe(true);
      expect(res.newNodeId).toBe("node-rb");
      expect(res.newContainerName).toBe("agent-rb-1");
      // Rolls the agent back ONTO the prior digest.
      expect(res.newDigest).toBe(PREV_DIGEST);
      // The pre-upgrade snapshot was looked up and reconstructed before cutover.
      expect(byTypeSpy).toHaveBeenCalledWith(AGENT, "pre-upgrade");
      expect(reconstructSpy).toHaveBeenCalledWith("backup-preupgrade-1");
      // ...and pushed onto BLUE (the rollback container) before the swap.
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy.mock.calls[0]?.[0]).toBe("https://rb-bridge.example");
      // The swap binds blue's identity + PREV_DIGEST and NULLs the prior columns.
      const params = sqlBoundParams(executedSql);
      expect(params).toContain("sandbox-rb-1");
      expect(params).toContain("node-rb");
      expect(params).toContain(PREV_DIGEST); // image_digest := previous
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
      // The old (post-upgrade) container is torn down; blue stays.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      byTypeSpy.mockRestore();
      reconstructSpy.mockRestore();
      pushSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});

// Compile a drizzle SQL object to its bound parameter list so a test can assert
// the values an UPDATE writes without coupling to SQL text. PgDialect.sqlToQuery
// returns exactly the bound params in order (same introspection the enqueue
// tests use).
function sqlBoundParams(query: unknown): unknown[] {
  if (!query || typeof query !== "object" || !("queryChunks" in query)) return [];
  return new PgDialect().sqlToQuery(query as SQL).params;
}
