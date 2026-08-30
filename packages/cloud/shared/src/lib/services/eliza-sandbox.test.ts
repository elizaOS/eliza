/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { KeyNotFoundError, KmsError, orgKey } from "@elizaos/core/security/kms";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { decryptField, encryptField } from "../../db/crypto/field-crypto";
import { resetKmsClientForTests } from "../../db/crypto/kms-client";
import * as realEnsureSchemaNs from "../../db/ensure-agent-sandbox-schema";
import * as realHelpersNs from "../../db/helpers";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import type { AgentSandbox, AgentSandboxBackup } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { userCharactersRepository } from "../../db/repositories/characters";
import type { DockerNode } from "../../db/repositories/docker-nodes";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { sharedRuntimeHistoryRepository } from "../../db/repositories/shared-runtime-history";
import {
  CONTAINER_BACKED_EXECUTION_TIERS,
  type StoredAgentSandboxBackup,
  WARM_POOL_ORG_ID,
  WARM_POOL_USER_ID,
} from "../../db/schemas/agent-sandboxes";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import { DockerSSHClient } from "./docker-ssh";
import {
  AGENT_CHARACTER_OWNERSHIP_KEY,
  AGENT_MANAGED_DISCORD_GATEWAY_KEY,
  AGENT_MANAGED_DISCORD_KEY,
  AGENT_MANAGED_GITHUB_KEY,
  AGENT_PERSONAL_CUTOVER_KEY,
  AGENT_UPGRADED_FROM_KEY,
} from "./eliza-agent-config";
import { provisioningJobService } from "./provisioning-jobs";
import { resolveSandboxContainerLaunchConfig } from "./sandbox-container-launch-config";
import {
  type SandboxCreateConfig,
  type SandboxHandle,
  type SandboxProvider,
  SandboxReplacementCleanupUnresolvedError,
} from "./sandbox-provider-types";

// Drive the real core KMS stack so the errors the snapshot-degrade
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
type UpgradeTransactionOutcome =
  | { status: "resolved"; value: unknown }
  | { status: "rejected" }
  | null;
// VALUE snapshot taken at module evaluation, while no mock is installed:
// `db/helpers` re-exports `dbWrite` from `db/client`, so bun's module mocks
// patch the SHARED live binding — building the restore (or this override's
// spread) from the live namespace after a mock landed would capture the mock.
const realHelpers = { ...realHelpersNs };
// Same VALUE-snapshot rule for the self-healing DDL guard: prepareAgentDelete
// awaits ensureAgentSandboxSchema() before its transaction, and this file's
// swapped `dbWrite` forwards `.execute` to the real connection — so the real
// guard would attempt live DDL here. This is a mocked-database suite; the
// guard itself is covered by the PGlite tests.
const realEnsureSchema = { ...realEnsureSchemaNs };
let upgradeTransactionImpl: (<T>(fn: (tx: UpgradeTx) => Promise<T>) => Promise<T>) | null = null;
let upgradeTransactionOutcome: UpgradeTransactionOutcome = null;
const realDbWrite = realHelpers.dbWrite as unknown as object;
const upgradeDbWrite = new Proxy(realDbWrite, {
  get(target, property, receiver) {
    if (property === "transaction") {
      return async <T>(fn: (tx: UpgradeTx) => Promise<T>): Promise<T> => {
        if (!upgradeTransactionImpl) {
          throw new Error(
            "dbWrite.transaction called without an active upgradeTransactionImpl (test wiring bug)",
          );
        }
        try {
          const value = await upgradeTransactionImpl(fn);
          upgradeTransactionOutcome = { status: "resolved", value };
          return value;
        } catch (error) {
          upgradeTransactionOutcome = { status: "rejected" };
          throw error;
        }
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

type ReplacementExpectation = {
  status: AgentSandbox["status"];
  environmentRevision: number;
  sandboxId: string | null;
  nodeId: string | null;
  containerName: string | null;
};

type TestReplacementLocator = {
  sandboxId: string;
  nodeId: string;
  containerName: string;
  replacementAttemptId: string | null;
  containerId: string | null;
  vpnNodeId: string | null;
  vpnNodeName: string | null;
  previousVpnNodeId: string | null;
  vpnRegistrationStartedAt: Date | null;
  allocationCounted: boolean;
  createdAt: Date;
};

type ReplacementLifecycleHarnessState = {
  candidate: TestReplacementLocator | null;
  expected: ReplacementExpectation | null;
};

type ReplacementLifecycleHarnessService = {
  persistReplacementCleanupStage(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expected: ReplacementExpectation,
    stage: "intent" | "created" | "vpn",
  ): Promise<void>;
  transferReplacementToPrimary(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expectedEnvironmentRevision: number,
    updateData: Partial<AgentSandbox>,
  ): Promise<AgentSandbox>;
  retirePersistedReplacementCleanup(agentId: string, orgId: string): Promise<boolean>;
  getReplacementCleanupLocator(rec: AgentSandbox): TestReplacementLocator | null;
  getProvider(): Promise<SandboxProvider>;
};

const replacementLifecycleHarnessState = new WeakMap<object, ReplacementLifecycleHarnessState>();
let restoreReplacementLifecycleHarness: (() => void) | null = null;
const replacementAwareProviderMarker = Symbol("replacement-aware-provider");
let replacementAttemptSequence = 0;

function replacementLocatorFromTestHandle(
  handle: SandboxHandle,
  createdAt = new Date("2026-07-23T00:00:00.000Z"),
): TestReplacementLocator {
  const metadata = handle.metadata ?? {};
  const nodeId = typeof metadata.nodeId === "string" ? metadata.nodeId : "";
  const containerName = typeof metadata.containerName === "string" ? metadata.containerName : "";
  const replacementAttemptId =
    typeof metadata.replacementAttemptId === "string" ? metadata.replacementAttemptId : null;
  const vpnRegistrationStartedAt =
    typeof metadata.vpnRegistrationStartedAt === "string"
      ? new Date(metadata.vpnRegistrationStartedAt)
      : null;
  return {
    sandboxId: handle.sandboxId,
    nodeId,
    containerName,
    replacementAttemptId,
    containerId: typeof metadata.containerId === "string" ? metadata.containerId : null,
    vpnNodeId: typeof metadata.vpnNodeId === "string" ? metadata.vpnNodeId : null,
    vpnNodeName: typeof metadata.vpnNodeName === "string" ? metadata.vpnNodeName : null,
    previousVpnNodeId:
      typeof metadata.previousVpnNodeId === "string" ? metadata.previousVpnNodeId : null,
    vpnRegistrationStartedAt,
    allocationCounted: metadata.allocationCounted === true,
    createdAt,
  };
}

function expectSameReplacement(
  existing: TestReplacementLocator,
  incoming: TestReplacementLocator,
): void {
  expect(incoming).toMatchObject({
    sandboxId: existing.sandboxId,
    nodeId: existing.nodeId,
    containerName: existing.containerName,
    replacementAttemptId: existing.replacementAttemptId,
    vpnNodeName: existing.vpnNodeName,
    previousVpnNodeId: existing.previousVpnNodeId,
    allocationCounted: existing.allocationCounted,
  });
  expect(incoming.vpnRegistrationStartedAt?.getTime() ?? null).toBe(
    existing.vpnRegistrationStartedAt?.getTime() ?? null,
  );
}

/**
 * Makes the deterministic provider fixtures honor Docker's durable replacement
 * callback order. Real provider coverage owns the remote Docker/VPN mechanics;
 * this harness keeps orchestration tests faithful without opening SSH.
 */
function replacementAwareProvider<T extends SandboxProvider>(provider: T): T {
  const mutable = provider as T & {
    [replacementAwareProviderMarker]?: true;
    stop?: (sandboxId: string) => Promise<void>;
  };
  if (mutable[replacementAwareProviderMarker]) return provider;
  mutable[replacementAwareProviderMarker] = true;
  const originalCreate = provider.create.bind(provider);
  if (!provider.stopForReplacement) {
    const legacyFixtureStop = mutable.stop?.bind(provider);
    provider.stopForReplacement = legacyFixtureStop
      ? legacyFixtureStop
      : async (sandboxId) => {
          const outcome = await provider.stopForDeletion(sandboxId);
          if (outcome.kind !== "not-running-proven") {
            throw new Error("Replacement fixture could not prove the sandbox stopped");
          }
        };
  }
  provider.create = async (config: SandboxCreateConfig): Promise<SandboxHandle> => {
    let intentCalled = false;
    let createdCalled = false;
    let vpnCalled = false;
    const wrappedConfig: SandboxCreateConfig = {
      ...config,
      onReplacementCreateIntent: config.onReplacementCreateIntent
        ? async (handle) => {
            intentCalled = true;
            await config.onReplacementCreateIntent?.(handle);
          }
        : undefined,
      onReplacementCreated: config.onReplacementCreated
        ? async (handle) => {
            createdCalled = true;
            await config.onReplacementCreated?.(handle);
          }
        : undefined,
      onReplacementVpnRegistered: config.onReplacementVpnRegistered
        ? async (handle) => {
            vpnCalled = true;
            await config.onReplacementVpnRegistered?.(handle);
          }
        : undefined,
    };
    const rawHandle = await originalCreate(wrappedConfig);
    const rawMetadata = rawHandle.metadata ?? {};
    const nodeId = typeof rawMetadata.nodeId === "string" ? rawMetadata.nodeId : "";
    const containerName =
      typeof rawMetadata.containerName === "string" ? rawMetadata.containerName : "";
    if (
      rawMetadata.provider !== "docker" ||
      !nodeId ||
      !containerName ||
      !config.onReplacementCreateIntent
    ) {
      return rawHandle;
    }

    replacementAttemptSequence += 1;
    const replacementAttemptId =
      typeof rawMetadata.replacementAttemptId === "string"
        ? rawMetadata.replacementAttemptId
        : `00000000-0000-4000-8000-${replacementAttemptSequence.toString().padStart(12, "0")}`;
    const baseMetadata = {
      ...rawMetadata,
      replacementAttemptId,
      allocationCounted: rawMetadata.allocationCounted !== false,
    };
    const intentHandle: SandboxHandle = {
      ...rawHandle,
      metadata: {
        ...baseMetadata,
        containerId: null,
        vpnNodeId: null,
      },
    };
    if (!intentCalled) await config.onReplacementCreateIntent(intentHandle);

    const createdHandle: SandboxHandle = {
      ...rawHandle,
      metadata: {
        ...baseMetadata,
        containerId:
          typeof rawMetadata.containerId === "string"
            ? rawMetadata.containerId
            : `container-${rawHandle.sandboxId}`,
        vpnNodeId: null,
      },
    };
    if (!createdCalled) await config.onReplacementCreated?.(createdHandle);

    if (typeof rawMetadata.vpnNodeId === "string") {
      const vpnHandle: SandboxHandle = {
        ...createdHandle,
        metadata: {
          ...createdHandle.metadata,
          vpnNodeId: rawMetadata.vpnNodeId,
        },
      };
      if (!vpnCalled) await config.onReplacementVpnRegistered?.(vpnHandle);
      return vpnHandle;
    }
    return createdHandle;
  };
  return provider;
}
// Installed in beforeAll — never at module scope: `bun test` evaluates every
// test file's module scope up front, so a module-scope mock would clobber the
// shared helpers/client bindings under every OTHER suite in a multi-file run
// (the changed-files coverage lane co-runs suites in one process, #15943).
beforeAll(async () => {
  mock.module("../../db/helpers", () => ({
    ...realHelpers,
    dbWrite: upgradeDbWrite,
  }));
  mock.module("../../db/ensure-agent-sandbox-schema", () => ({
    ...realEnsureSchema,
    ensureAgentSandboxSchema: async () => {},
  }));

  const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
  const prototype = ElizaSandboxService.prototype as unknown as ReplacementLifecycleHarnessService;
  const originals = {
    persistReplacementCleanupStage: prototype.persistReplacementCleanupStage,
    transferReplacementToPrimary: prototype.transferReplacementToPrimary,
    retirePersistedReplacementCleanup: prototype.retirePersistedReplacementCleanup,
    getReplacementCleanupLocator: prototype.getReplacementCleanupLocator,
  };

  prototype.persistReplacementCleanupStage = async function (
    _agentId,
    _orgId,
    handle,
    expected,
    stage,
  ): Promise<void> {
    const state = replacementLifecycleHarnessState.get(this) ?? {
      candidate: null,
      expected: null,
    };
    const incoming = replacementLocatorFromTestHandle(handle, state.candidate?.createdAt);
    if (!incoming.nodeId || !incoming.containerName || !incoming.replacementAttemptId) {
      throw new Error("Replacement fixture has incomplete durable placement identity");
    }
    if (stage === "intent") {
      expect(incoming.containerId).toBeNull();
      expect(incoming.vpnNodeId).toBeNull();
      expect(incoming.allocationCounted).toBe(true);
      if (state.candidate) expectSameReplacement(state.candidate, incoming);
      state.candidate = incoming;
      state.expected = expected;
      upgradeTransactionOutcome = null;
    } else {
      if (!state.candidate) {
        throw new Error("Replacement fixture enrichment arrived before durable intent");
      }
      expectSameReplacement(state.candidate, incoming);
      if (stage === "created") {
        expect(incoming.containerId).not.toBeNull();
        state.candidate.containerId = incoming.containerId;
      } else {
        expect(incoming.vpnNodeId).not.toBeNull();
        state.candidate.containerId = incoming.containerId;
        state.candidate.vpnNodeId = incoming.vpnNodeId;
      }
    }
    replacementLifecycleHarnessState.set(this, state);
  };

  prototype.transferReplacementToPrimary = async function (
    agentId,
    _orgId,
    handle,
    expectedEnvironmentRevision,
    updateData,
  ): Promise<AgentSandbox> {
    const state = replacementLifecycleHarnessState.get(this) ?? {
      candidate: null,
      expected: null,
    };
    let incoming = replacementLocatorFromTestHandle(handle, state.candidate?.createdAt);
    if (state.candidate) {
      expectSameReplacement(state.candidate, incoming);
      expect(incoming.containerId).toBe(state.candidate.containerId);
      expect(incoming.vpnNodeId).toBe(state.candidate.vpnNodeId);
      expect(state.expected?.environmentRevision).toBe(expectedEnvironmentRevision);
    } else if (handle.metadata?.provider === "docker") {
      // Provision tests whose provider fake intentionally omits Docker's remote
      // internals still enter adoption with the exact returned handle. Model
      // the provider's already-covered durable intent+created result here;
      // retry-adoption fixtures likewise begin with this handle on the row.
      expect(handle.sandboxId).toBe(updateData.sandbox_id);
      replacementAttemptSequence += 1;
      incoming = {
        ...incoming,
        replacementAttemptId: `00000000-0000-4000-8000-${replacementAttemptSequence
          .toString()
          .padStart(12, "0")}`,
        containerId: `container-${handle.sandboxId}`,
        allocationCounted: true,
      };
      state.candidate = incoming;
      state.expected = {
        status: "provisioning",
        environmentRevision: expectedEnvironmentRevision,
        sandboxId: null,
        nodeId: null,
        containerName: null,
      };
      replacementLifecycleHarnessState.set(this, state);
    }
    replacementAwareProvider(await this.getProvider());
    const adopted = await agentSandboxesRepository.update(agentId, updateData);
    if (!adopted) throw new Error("Replacement adoption CAS failed");
    state.candidate = null;
    state.expected = null;
    replacementLifecycleHarnessState.set(this, state);
    return adopted;
  };

  prototype.getReplacementCleanupLocator = function (
    rec: AgentSandbox,
  ): TestReplacementLocator | null {
    const persisted = originals.getReplacementCleanupLocator.call(this, rec);
    if (persisted) return persisted;
    return replacementLifecycleHarnessState.get(this)?.candidate ?? null;
  };

  prototype.retirePersistedReplacementCleanup = async function (): Promise<boolean> {
    const state = replacementLifecycleHarnessState.get(this);
    if (!state?.candidate) return false;
    const provider = await this.getProvider();
    const cutoverCommitted =
      upgradeTransactionOutcome?.status === "resolved" &&
      upgradeTransactionOutcome.value === true &&
      state.expected?.status === "running";
    const locator = cutoverCommitted
      ? {
          ...state.candidate,
          sandboxId: state.expected?.sandboxId ?? "",
          nodeId: state.expected?.nodeId ?? "",
          containerName: state.expected?.containerName ?? "",
          replacementAttemptId: null,
          containerId: null,
          vpnNodeId: state.candidate.previousVpnNodeId,
          vpnNodeName: null,
          previousVpnNodeId: null,
          vpnRegistrationStartedAt: null,
          allocationCounted: true,
        }
      : state.candidate;
    if (!locator.sandboxId || !locator.nodeId || !locator.containerName) {
      throw new Error("Replacement fixture has no cleanup identity");
    }
    if (provider.stopOnSpecificNodeForReplacement) {
      await provider.stopOnSpecificNodeForReplacement(
        locator.nodeId,
        locator.containerName,
        locator.vpnNodeId,
        {
          replacementAttemptId: locator.replacementAttemptId,
          containerId: locator.containerId,
          vpnNodeName: locator.vpnNodeName,
          previousVpnNodeId: locator.previousVpnNodeId,
          vpnRegistrationStartedAt: locator.vpnRegistrationStartedAt?.toISOString() ?? null,
          allocationCounted: locator.allocationCounted,
        },
      );
    } else if (provider.stopForReplacement) {
      await provider.stopForReplacement(locator.sandboxId);
    } else {
      throw new Error("Sandbox provider cannot prove failed provision absent");
    }
    state.candidate = null;
    state.expected = null;
    replacementLifecycleHarnessState.set(this, state);
    return true;
  };

  restoreReplacementLifecycleHarness = () => {
    prototype.persistReplacementCleanupStage = originals.persistReplacementCleanupStage;
    prototype.transferReplacementToPrimary = originals.transferReplacementToPrimary;
    prototype.retirePersistedReplacementCleanup = originals.retirePersistedReplacementCleanup;
    prototype.getReplacementCleanupLocator = originals.getReplacementCleanupLocator;
  };
});
afterAll(() => {
  restoreReplacementLifecycleHarness?.();
  mock.module("../../db/helpers", () => realHelpers);
  mock.module("../../db/ensure-agent-sandbox-schema", () => realEnsureSchema);
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
const settleLifecycleBillingSpy = spyOn(
  agentBillingRepository,
  "settleAccruedBillingBeforeLifecycle",
).mockResolvedValue({ status: "already_billed_recently" });
const settleLifecycleBillingInTransactionSpy = spyOn(
  agentBillingRepository,
  "settleAccruedBillingBeforeLifecycleInTransaction",
).mockResolvedValue({ status: "already_billed_recently" });

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
    deletion_attempt_id: null,
    deletion_started_at: null,
    deletion_previous_status: null,
    deletion_previous_billing_status: null,
    deletion_previous_shutdown_warning_sent_at: null,
    deletion_previous_scheduled_shutdown_at: null,
    pre_delete_capture_waiver_attempt_id: null,
    pre_delete_capture_waiver_environment_revision: null,
    pre_delete_capture_waiver_sandbox_id: null,
    pre_delete_capture_waiver_bridge_url: null,
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
    environment_revision: 0,
    lifecycle_revision: 0,
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
    warm_claim_credential_state: null,
    warm_claim_source_pool_id: null,
    warm_claim_key_fingerprint: null,
    warm_claim_attested_at: null,
    warm_claim_attested_environment_revision: null,
    warm_claim_cleanup_completed_at: null,
    replacement_cleanup_sandbox_id: null,
    replacement_cleanup_node_id: null,
    replacement_cleanup_container_name: null,
    replacement_cleanup_attempt_id: null,
    replacement_cleanup_container_id: null,
    replacement_cleanup_vpn_node_id: null,
    replacement_cleanup_vpn_node_name: null,
    replacement_cleanup_preserved_vpn_node_id: null,
    replacement_cleanup_vpn_registration_started_at: null,
    replacement_cleanup_allocation_counted: null,
    replacement_cleanup_created_at: null,
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

describe("buildAgentSandboxInsertValues", () => {
  test("derives trusted storage fields while rejecting caller-owned internal config", async () => {
    const { buildAgentSandboxInsertValues } = await import("./eliza-sandbox.ts?actual");

    expect(
      buildAgentSandboxInsertValues({
        organizationId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        agentName: "bnancy",
        characterId: "44444444-4444-4444-8444-444444444444",
        executionTier: "custom",
        agentConfig: {
          bio: "A real caller-owned persona",
          __agentUpgradedFrom: "forged-source-agent",
        },
        environmentVars: { ELIZA_API_TOKEN: "encrypted-token" },
      }),
    ).toMatchObject({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      agent_name: "bnancy",
      character_id: "44444444-4444-4444-8444-444444444444",
      execution_tier: "custom",
      status: "pending",
      database_status: "none",
      agent_config: {
        bio: "A real caller-owned persona",
        __agentCharacterOwnership: "reuse-existing",
      },
      environment_vars: { ELIZA_API_TOKEN: "encrypted-token" },
    });
  });

  test("seeds the canonical cloud character when a managed create brings no persona", async () => {
    const { buildAgentSandboxInsertValues } = await import("./eliza-sandbox.ts?actual");
    const { buildDefaultAgentCharacterConfig } = await import("./default-agent-character");
    const seed = buildDefaultAgentCharacterConfig();

    for (const executionTier of ["shared", "dedicated-always"] as const) {
      const config = buildAgentSandboxInsertValues({
        organizationId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        agentName: "bnancy",
        executionTier,
      }).agent_config as Record<string, unknown>;

      expect(config.system).toBe(seed.system);
      expect(config.bio).toEqual(seed.bio);
      expect(config.style).toEqual(seed.style);
      expect(config.messageExamples).toEqual(seed.messageExamples);
      // The agent's own name stays in the `agent_name` column so a later rename
      // still reaches every reader; the seed must not pin it into the config.
      expect(config.name).toBeUndefined();
      expect(config.system).not.toBe("You are bnancy, a helpful assistant.");
    }
  });

  test("leaves a caller-supplied or character-linked create unseeded", async () => {
    const { agentConfigForProvision, buildAgentSandboxInsertValues } = await import(
      "./eliza-sandbox.ts?actual"
    );
    const base = {
      organizationId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      agentName: "bnancy",
      executionTier: "shared" as const,
    };

    expect(
      buildAgentSandboxInsertValues({
        ...base,
        agentConfig: { system: "You are bnancy, the caller's own persona." },
      }).agent_config,
    ).toEqual({ system: "You are bnancy, the caller's own persona." });

    expect(
      buildAgentSandboxInsertValues({
        ...base,
        agentConfig: { character: { system: "nested caller persona" } },
      }).agent_config,
    ).toEqual({ character: { system: "nested caller persona" } });

    expect(
      buildAgentSandboxInsertValues({
        ...base,
        characterId: "44444444-4444-4444-8444-444444444444",
      }).agent_config,
    ).toEqual({ __agentCharacterOwnership: "reuse-existing" });

    const custom = buildAgentSandboxInsertValues({
      ...base,
      dockerImage: "ghcr.io/dexploarer/bnancy:latest",
      executionTier: "custom",
    });
    expect(custom.agent_config).toEqual({});
    expect(agentConfigForProvision(custom)).toBeUndefined();
  });
});

describe("ElizaSandboxService state restore auth", () => {
  test("attaches the agent token when restoring to a trusted bridge URL string", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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
      "./eliza-sandbox.ts?actual"
    );
    const { SnapshotPayloadTooLargeError } = await import("@elizaos/shared/agent-backup-limits");
    const err = new SnapshotPayloadTooLargeError(200, 100);

    expect(isUnrecoverableSnapshotError(err)).toBe(false);
    expect(isPermanentlyLostSnapshot(err)).toBe(false);
    expect(err.payloadBytes).toBe(200);
    expect(err.limitBytes).toBe(100);
  });

  test("pushes a restore payload that fits the v1 restorable limit (#17172)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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
      if (url === "https://eliza-production-1.elizacloud.ai/api/agents") {
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
      expect(requests).toEqual([
        {
          url: "https://eliza-production-1.elizacloud.ai/api/agents",
          headers: {
            authorization: "Bearer agent-token",
            "content-type": "application/json",
            "x-api-key": "agent-token",
            "x-eliza-token": "agent-token",
            "x-forwarded-host": `${sandbox.id}.elizacloud.ai`,
            "x-forwarded-proto": "https",
          },
        },
        {
          url: "https://eliza-production-1.elizacloud.ai/",
          headers: {
            authorization: "Bearer agent-token",
            "content-type": "application/json",
            "x-api-key": "agent-token",
            "x-eliza-token": "agent-token",
            "x-forwarded-host": `${sandbox.id}.elizacloud.ai`,
            "x-forwarded-proto": "https",
          },
        },
      ]);
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
      const historyMergeSpy = spyOn(sharedRuntimeHistoryRepository, "merge").mockResolvedValue([]);

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
            transport: "shared-runtime",
          },
        });
        expect(historyGetSpy).toHaveBeenCalled();
        expect(historyMergeSpy).not.toHaveBeenCalled();
      } finally {
        findRunningSandboxSpy.mockRestore();
        historyGetSpy.mockRestore();
        historyMergeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "returns an SSE completion without persisting when streaming has no configured model",
    async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const sandbox = sharedSandbox();
      const findRunningSandboxSpy = spyOn(
        agentSandboxesRepository,
        "findRunningSandbox",
      ).mockResolvedValue(sandbox);
      const historyGetSpy = spyOn(sharedRuntimeHistoryRepository, "get").mockResolvedValue([]);
      const historyMergeSpy = spyOn(sharedRuntimeHistoryRepository, "merge").mockResolvedValue([]);

      try {
        const response = await runWithCloudBindings(
          {
            CEREBRAS_API_KEY: "",
            OPENAI_API_KEY: "",
          },
          () =>
            new ElizaSandboxService().bridgeStream(sandbox.id, sandbox.organization_id, {
              jsonrpc: "2.0",
              id: "shared-stream-turn",
              method: "message.send",
              params: { text: " hello " },
            }),
        );

        expect(response).toBeInstanceOf(Response);
        expect(response?.headers.get("content-type")).toContain("text/event-stream");
        const body = await response?.text();
        expect(body).toContain("event: chunk");
        expect(body).toContain("no shared model configured");
        expect(body).toContain("event: done");
        expect(historyGetSpy).toHaveBeenCalled();
        expect(historyMergeSpy).not.toHaveBeenCalled();
      } finally {
        findRunningSandboxSpy.mockRestore();
        historyGetSpy.mockRestore();
        historyMergeSpy.mockRestore();
      }
    },
  );

  test("wake canonical→Shared checkpoint race performs no integrity stamp or provision", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const initial: AgentSandbox = {
      ...customSandbox(),
      status: "sleeping",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
    };
    const shared: AgentSandbox = { ...initial, execution_tier: "shared" };
    type WakeRaceService = {
      executeWake(
        agentId: string,
        orgId: string,
      ): Promise<{
        success: boolean;
        reprovisioned: boolean;
        error?: string;
      }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      provision(agentId: string, orgId: string): Promise<unknown>;
    };
    const svc = new ElizaSandboxService() as unknown as WakeRaceService;
    const primary = spyOn(svc, "getAgentForWrite").mockResolvedValue(initial);
    const lock = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const lockedRead = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(shared);
    const stamp = spyOn(agentSandboxesRepository, "stampBackupVerification");
    const latest = spyOn(agentSandboxesRepository, "getLatestStoredBackup");
    const provision = spyOn(svc, "provision");
    let rawWrites = 0;
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => {
          rawWrites += 1;
          return { rows: [] };
        },
      });
    try {
      await expect(svc.executeWake(initial.id, initial.organization_id)).resolves.toEqual({
        success: false,
        reprovisioned: false,
        error: "Agent lifecycle changed before wake restore validation",
      });
      expect(stamp).not.toHaveBeenCalled();
      expect(latest).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(rawWrites).toBe(0);
    } finally {
      upgradeTransactionImpl = null;
      primary.mockRestore();
      lock.mockRestore();
      lockedRead.mockRestore();
      stamp.mockRestore();
      latest.mockRestore();
      provision.mockRestore();
    }
  });
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
        verification_status: null,
        verified_at: null,
        verification_error: null,
      };
      // The wake restore-integrity gate (#15603 B6) verifies the STORED row
      // before provision runs; a plaintext inline full backup with no
      // content_hash passes verification for real (legacy-row passthrough).
      const storedBackup: StoredAgentSandboxBackup = {
        ...backup,
        // Explicit nulls: the legacy-verification predicate compares against
        // null, so an absent catalog field would classify the row as
        // catalogue-managed and reject the legacy lane.
        catalog_version: null,
        catalog_state: null,
        state_data: { memories: [], config: {}, workspaceFiles: {} },
      } as StoredAgentSandboxBackup;
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
        stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
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
      const originalGetBackupById = agentSandboxesRepository.getBackupById;
      const originalGetLatestStoredBackup = agentSandboxesRepository.getLatestStoredBackup;
      const originalListBackupMetadata = agentSandboxesRepository.listBackupMetadata;
      const originalStampBackupVerification = agentSandboxesRepository.stampBackupVerification;
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
      // The wake hands provision the gate-validated backup as an explicit
      // from-backup override, so provision fetches it by id, not "latest".
      agentSandboxesRepository.getBackupById = mock(async () => backup);
      agentSandboxesRepository.getLatestStoredBackup = mock(async () => storedBackup);
      agentSandboxesRepository.listBackupMetadata = mock(async () => [
        {
          id: backup.id,
          sandbox_record_id: backup.sandbox_record_id,
          snapshot_type: backup.snapshot_type,
          state_data_storage: backup.state_data_storage,
          state_data_key: backup.state_data_key,
          size_bytes: backup.size_bytes,
          backup_kind: backup.backup_kind,
          parent_backup_id: backup.parent_backup_id,
          content_hash: backup.content_hash,
          verification_status: backup.verification_status,
          verified_at: backup.verified_at,
          verification_error: backup.verification_error,
          recovery_organization_id: null,
          recovery_agent_id: null,
          recovery_deletion_attempt_id: null,
          recovery_expires_at: null,
          created_at: backup.created_at,
        },
      ]);
      agentSandboxesRepository.stampBackupVerification = mock(async () => {});
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
      const gateAuthority = spyOn(
        ElizaSandboxService.prototype as unknown as {
          revalidateContainerBackedLifecycleGeneration: () => Promise<AgentSandbox | undefined>;
        },
        "revalidateContainerBackedLifecycleGeneration",
      ).mockResolvedValue(sleepingSandbox);

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
        agentSandboxesRepository.getBackupById = originalGetBackupById;
        agentSandboxesRepository.getLatestStoredBackup = originalGetLatestStoredBackup;
        agentSandboxesRepository.listBackupMetadata = originalListBackupMetadata;
        agentSandboxesRepository.stampBackupVerification = originalStampBackupVerification;
        agentSandboxesRepository.getReconstructedBackupState = originalGetReconstructedBackupState;
        createForAgentSpy.mockRestore();
        updateSpy.mockRestore();
        gateAuthority.mockRestore();
      }
    },
  );
});

// The from-backup override contract (#15603 B6), exercised through the REAL
// provision() restore step: an explicitly-requested backup must NEVER degrade
// to a fresh boot or prune the chain — the provision fails (retryable by the
// wake job) with every backup intact. Repository reads/writes are stubbed at
// the seam and the provider/runtime fetches are fakes, but the restore errors
// are genuine (real AEAD decrypt failure, real HTTP restore rejection) and the
// code under test is provision()'s own catch ladder, not a stand-in.
describe("ElizaSandboxService provision — from-backup override (#15603 B6)", () => {
  const FROM_BACKUP_ID = "44444444-4444-4444-8444-444444444444";

  function sleepingSandboxRec(): AgentSandbox {
    return {
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
    };
  }

  function backupRow(sandboxRecordId: string): AgentSandboxBackup {
    return {
      id: FROM_BACKUP_ID,
      sandbox_record_id: sandboxRecordId,
      snapshot_type: "pre-shutdown",
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      state_data_key: null,
      size_bytes: 2,
      backup_kind: "full",
      parent_backup_id: null,
      content_hash: null,
      created_at: new Date("2026-06-04T12:05:00.000Z"),
      verification_status: "verified",
      verified_at: new Date("2026-06-04T12:05:00.000Z"),
      verification_error: null,
    };
  }

  async function armFromBackupProvision(opts: {
    backupSandboxRecordId?: string;
    reconstructError?: Error;
    restoreHttpStatus?: number;
  }) {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = sleepingSandboxRec();
    const backup = backupRow(opts.backupSandboxRecordId ?? rec.id);
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
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      if (url === "https://runtime.example/api/agents") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (url === "https://runtime.example/api/restore" && opts.restoreHttpStatus) {
        return Response.json({ error: "restore rejected" }, { status: opts.restoreHttpStatus });
      }
      return Response.json({ ok: true });
    });
    const originals = {
      findByIdAndOrg: agentSandboxesRepository.findByIdAndOrg,
      findById: agentSandboxesRepository.findById,
      trySetProvisioning: agentSandboxesRepository.trySetProvisioning,
      getBackupById: agentSandboxesRepository.getBackupById,
      getLatestBackup: agentSandboxesRepository.getLatestBackup,
      getReconstructedBackupState: agentSandboxesRepository.getReconstructedBackupState,
    };
    // Ordinary provisions (no override) read the LATEST backup, not an id.
    agentSandboxesRepository.getLatestBackup = mock(async () => backup);
    agentSandboxesRepository.findByIdAndOrg = mock(async () => rec);
    agentSandboxesRepository.findById = mock(async () => rec);
    agentSandboxesRepository.trySetProvisioning = mock(async () => ({
      ...rec,
      status: "provisioning",
    }));
    const getBackupByIdMock = mock(async () => backup);
    agentSandboxesRepository.getBackupById = getBackupByIdMock;
    const reconstructMock = mock(async () => {
      if (opts.reconstructError) throw opts.reconstructError;
      return { memories: [], config: {}, workspaceFiles: {} };
    });
    agentSandboxesRepository.getReconstructedBackupState = reconstructMock;
    const createForAgentSpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...rec, ...data, updated_at: rec.updated_at }),
    );
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups");
    return {
      svc: new ElizaSandboxService(provider),
      rec,
      provider,
      getBackupByIdMock,
      reconstructMock,
      updateSpy,
      pruneSpy,
      restore: () => {
        agentSandboxesRepository.findByIdAndOrg = originals.findByIdAndOrg;
        agentSandboxesRepository.findById = originals.findById;
        agentSandboxesRepository.trySetProvisioning = originals.trySetProvisioning;
        agentSandboxesRepository.getBackupById = originals.getBackupById;
        agentSandboxesRepository.getLatestBackup = originals.getLatestBackup;
        agentSandboxesRepository.getReconstructedBackupState =
          originals.getReconstructedBackupState;
        createForAgentSpy.mockRestore();
        updateSpy.mockRestore();
        pruneSpy.mockRestore();
      },
    };
  }

  test("an unreconstructable explicit backup FAILS the provision — no fresh boot, no prune", async () => {
    // A REAL AeadError: without the override this exact error is classified
    // unrecoverable and degrades to a fresh boot + pruneBackups(rec.id, 0).
    const aead = await realAeadDecryptError();
    const h = await armFromBackupProvision({ reconstructError: aead });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id, {
        kind: "from-backup",
        backupId: FROM_BACKUP_ID,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toBe(aead.message);
      // The degrade path never fired: the chain survives for the retry.
      expect(h.pruneSpy).not.toHaveBeenCalled();
      // The row is flipped out of `running` (markError), and the half-built
      // container is torn down per the post-create-failure convention.
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
      expect(h.provider.stopForReplacement).toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("a restore push the runtime rejects FAILS a from-backup provision (custom-image 404 skip stays 404-only)", async () => {
    const h = await armFromBackupProvision({ restoreHttpStatus: 500 });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id, {
        kind: "from-backup",
        backupId: FROM_BACKUP_ID,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toContain("State restore failed: HTTP 500");
      expect(h.pruneSpy).not.toHaveBeenCalled();
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
    } finally {
      h.restore();
    }
  });

  test("a backup belonging to another sandbox is rejected in provision (defense in depth behind the gate)", async () => {
    const h = await armFromBackupProvision({
      backupSandboxRecordId: "55555555-5555-4555-8555-555555555555",
    });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id, {
        kind: "from-backup",
        backupId: FROM_BACKUP_ID,
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toBe(`Restore backup ${FROM_BACKUP_ID} not found for this agent`);
      // Rejected before any state was read or touched.
      expect(h.reconstructMock).not.toHaveBeenCalled();
      expect(h.pruneSpy).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("an oversized restore FAILS an ORDINARY provision closed — no silent fresh boot (#17180 §1)", async () => {
    // The chain is intact, only too large. Booting empty would silently drop
    // every byte of it, so the refusal must look exactly like the explicit
    // from-backup failure: status error, container torn down, chain unpruned.
    const { SnapshotPayloadTooLargeError } = await import("@elizaos/shared/agent-backup-limits");
    const h = await armFromBackupProvision({
      reconstructError: new SnapshotPayloadTooLargeError(200 * 1024 * 1024, 128 * 1024 * 1024),
    });
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toContain("forceFreshBoot");
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
      expect(h.provider.stopForReplacement).toHaveBeenCalled();
      expect(h.pruneSpy).not.toHaveBeenCalled();
    } finally {
      h.restore();
    }
  });

  test("an oversized restore PUSH also fails an ordinary provision closed (#17180 §1)", async () => {
    const { SnapshotPayloadTooLargeError } = await import("@elizaos/shared/agent-backup-limits");
    const h = await armFromBackupProvision({});
    // The push-side refusal fires from the serialized body size inside
    // pushState; injecting at the method boundary avoids materializing 128 MiB
    // in the test while exercising the provision branch that catches it.
    const pushSpy = spyOn(
      h.svc as unknown as { pushState: () => Promise<void> },
      "pushState",
    ).mockRejectedValue(new SnapshotPayloadTooLargeError(200 * 1024 * 1024, 128 * 1024 * 1024));
    try {
      const result = await h.svc.provision(h.rec.id, h.rec.organization_id);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected provision failure");
      expect(result.error).toContain("forceFreshBoot");
      expect(h.updateSpy).toHaveBeenCalledWith(
        h.rec.id,
        expect.objectContaining({ status: "error" }),
      );
      expect(h.pruneSpy).not.toHaveBeenCalled();
    } finally {
      pushSpy.mockRestore();
      h.restore();
    }
  });
});

describe("ElizaSandboxService shutdown fails closed without a current capture (#17180 §2)", () => {
  test("a failing pre-stop capture refuses the shutdown and leaves the agent running", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const fetchSnap = spyOn(
      svc as unknown as { fetchSnapshotState: () => Promise<never> },
      "fetchSnapshotState",
    ).mockRejectedValue(new Error("snapshot endpoint timed out"));
    try {
      const result = await svc.shutdown(rec.id, rec.organization_id);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Refusing to stop without a current backup");
      expect(result.error).toContain("snapshot endpoint timed out");
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
    }
  });

  test("a transient capture refusal is retryable and leaves the agent running", async () => {
    const { ElizaSandboxService, SNAPSHOT_CAPTURE_TRANSIENT } = await import(
      "./eliza-sandbox.ts?actual"
    );
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const fetchSnap = spyOn(
      svc as unknown as { fetchSnapshotState: () => Promise<never> },
      "fetchSnapshotState",
    ).mockRejectedValue(new Error(SNAPSHOT_CAPTURE_TRANSIENT));
    try {
      await expect(svc.shutdown(rec.id, rec.organization_id)).resolves.toEqual({
        success: false,
        retryable: true,
        error: `Refusing to stop without a current backup: ${SNAPSHOT_CAPTURE_TRANSIENT}`,
      });
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
    }
  });

  test("a Shared tier observed under the lifecycle lock cannot stop or write", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const initial: AgentSandbox = {
      ...customSandbox(),
      status: "stopped",
      bridge_url: null,
      health_url: null,
    };
    const locked: AgentSandbox = { ...initial, execution_tier: "shared" };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type LockedShutdownService = {
      shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
    };
    const service = new ElizaSandboxService(provider) as unknown as LockedShutdownService;
    const primaryRead = spyOn(service, "getAgentForWrite").mockResolvedValue(initial);
    const lockLifecycle = spyOn(service, "lockLifecycle").mockResolvedValue(undefined);
    const lockedRead = spyOn(service, "getAgentForLifecycleMutation").mockResolvedValue(locked);
    let writeCalled = false;
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => {
          writeCalled = true;
          return { rows: [] };
        },
      });
    try {
      await expect(service.shutdown(initial.id, initial.organization_id)).resolves.toEqual({
        success: false,
        error: "Agent shutdown requires a container-backed execution tier",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writeCalled).toBe(false);
    } finally {
      upgradeTransactionImpl = null;
      primaryRead.mockRestore();
      lockLifecycle.mockRestore();
      lockedRead.mockRestore();
    }
  });

  test("a capture from generation A cannot be persisted onto or stop generation B that reuses its bridge URL", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const captured: AgentSandbox = {
      ...customSandbox(),
      lifecycle_revision: 41,
      environment_revision: 7,
    };
    const replacement: AgentSandbox = {
      ...captured,
      // Deliberately retain the bridge URL: this is the ABA shape the former
      // URL-only correlation admitted after the remote snapshot returned.
      sandbox_id: "sandbox-generation-b",
      node_id: "node-generation-b",
      container_name: "agent-generation-b",
      environment_revision: 8,
      lifecycle_revision: 42,
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type ShutdownGenerationService = {
      shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      fetchSnapshotState(rec: AgentSandbox): Promise<{
        stateData: { memories: unknown[]; config: Record<string, unknown>; workspaceFiles: object };
        sizeBytes: number;
        bridgeUrl: string;
      }>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      persistSnapshotWithinTransaction(...args: unknown[]): Promise<unknown>;
    };
    const service = new ElizaSandboxService(provider) as unknown as ShutdownGenerationService;
    const primaryRead = spyOn(service, "getAgentForWrite").mockResolvedValue(captured);
    const fetchSnapshot = spyOn(service, "fetchSnapshotState").mockResolvedValue({
      stateData: { memories: [], config: {}, workspaceFiles: {} },
      sizeBytes: 2,
      bridgeUrl: captured.bridge_url!,
    });
    const lockLifecycle = spyOn(service, "lockLifecycle").mockResolvedValue(undefined);
    const lockedRead = spyOn(service, "getAgentForLifecycleMutation").mockResolvedValue(
      replacement,
    );
    const persistSnapshot = spyOn(service, "persistSnapshotWithinTransaction");
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      await expect(service.shutdown(captured.id, captured.organization_id)).resolves.toEqual({
        success: false,
        error:
          "Refusing to stop: the agent's lifecycle generation moved after the pre-stop capture; retry the shutdown.",
      });
      expect(fetchSnapshot).toHaveBeenCalledWith(captured);
      expect(persistSnapshot).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally {
      upgradeTransactionImpl = null;
      primaryRead.mockRestore();
      fetchSnapshot.mockRestore();
      lockLifecycle.mockRestore();
      lockedRead.mockRestore();
      persistSnapshot.mockRestore();
    }
  });
});

describe("ElizaSandboxService shutdown state-loss-acknowledged override (#18228)", () => {
  function makeProvider(): SandboxProvider {
    return {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
  }

  test("a transfer-hop 500 refusal carries the hop's body, distinguishable from an agent-side capture failure", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider = makeProvider();
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    // Proxy-hop failure: the agent captured successfully (its handler never
    // ran this response), and the intermediate hop answered with its own
    // error page. The refusal must surface that page so the operator can
    // tell this apart from "agent cannot snapshot".
    const fetchApi = spyOn(
      svc as unknown as { fetchAgentApi: () => Promise<Response> },
      "fetchAgentApi",
    ).mockImplementation(
      async () =>
        new Response("upstream connect error or disconnect before headers", { status: 500 }),
    );
    try {
      const hopResult = await svc.shutdown(rec.id, rec.organization_id);
      expect(hopResult.success).toBe(false);
      expect(hopResult.error).toContain("Snapshot fetch failed: HTTP 500");
      expect(hopResult.error).toContain("upstream connect error");

      // Agent-side failure: the agent's own handler returned its thrown
      // message. Same status, different diagnostic body.
      fetchApi.mockImplementation(
        async () =>
          new Response('{"error":"Snapshot failed: pglite dump write error"}', { status: 500 }),
      );
      const agentResult = await svc.shutdown(rec.id, rec.organization_id);
      expect(agentResult.success).toBe(false);
      expect(agentResult.error).toContain("Snapshot fetch failed: HTTP 500");
      expect(agentResult.error).toContain("pglite dump write error");

      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchApi.mockRestore();
    }
  });

  test("stateLossAcknowledged proceeds to stop without a capture and reports the waiver", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider = makeProvider();
    const svc = new ElizaSandboxService(provider);
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const fetchApi = spyOn(
      svc as unknown as { fetchAgentApi: () => Promise<Response> },
      "fetchAgentApi",
    ).mockImplementation(
      async () =>
        new Response("upstream connect error or disconnect before headers", { status: 500 }),
    );
    const lockLifecycle = spyOn(
      svc as unknown as { lockLifecycle: () => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const getForMutation = spyOn(
      svc as unknown as { getAgentForLifecycleMutation: () => Promise<unknown> },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(rec);
    const activeProvision = spyOn(
      svc as unknown as { hasActiveProvisionJobTx: () => Promise<boolean> },
      "hasActiveProvisionJobTx",
    ).mockResolvedValue(false);
    const persistSnapshot = spyOn(
      svc as unknown as { persistSnapshotWithinTransaction: () => Promise<never> },
      "persistSnapshotWithinTransaction",
    );
    const prune = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(
      undefined as never,
    );
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });
    try {
      const result = await svc.shutdown(rec.id, rec.organization_id, {
        stateLossAcknowledged: true,
      });
      expect(result).toEqual({ success: true, stateLossAcknowledged: true });
      // The stop really happened; the capture was skipped, never persisted.
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(persistSnapshot).not.toHaveBeenCalled();
      expect(writes).toHaveLength(1);
    } finally {
      upgradeTransactionImpl = null;
      getForWrite.mockRestore();
      fetchApi.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      persistSnapshot.mockRestore();
      prune.mockRestore();
    }
  });

  test("executeRestart threads the waiver into shutdown", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const svc = new ElizaSandboxService(makeProvider());
    const getForWrite = spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<unknown> },
      "getAgentForWrite",
    ).mockResolvedValue(rec);
    const shutdownSpy = spyOn(svc, "shutdown").mockResolvedValue({
      success: true,
      stateLossAcknowledged: true,
    });
    const provisionSpy = spyOn(svc, "provision").mockResolvedValue({
      success: true,
      bridgeUrl: "https://bridge.example",
      healthUrl: "https://bridge.example/health",
    } as never);
    try {
      const res = await svc.executeRestart(rec.id, rec.organization_id, {
        stateLossAcknowledged: true,
      });
      expect(res.success).toBe(true);
      expect(shutdownSpy).toHaveBeenCalledWith(rec.id, rec.organization_id, {
        stateLossAcknowledged: true,
      });
    } finally {
      getForWrite.mockRestore();
      shutdownSpy.mockRestore();
      provisionSpy.mockRestore();
    }
  });
});

describe("ElizaSandboxService sleep refuses an unproven fallback backup (#17180 §3)", () => {
  test("capture failed and the latest stored backup cannot be verified — sleep aborts", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    globalThis.fetch = mock(async () => {
      throw new Error("snapshot unavailable");
    });
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    // Unstamped row whose payload really fails decrypt: a GENUINE envelope
    // encrypted under different AAD coordinates, so the verifier's decrypt
    // (bound to this row's id) raises a real AeadError and the REAL gate
    // classifies it decrypt-failed. (A non-envelope object would pass through
    // decrypt as legacy plaintext; a malformed key id would be an infra throw.)
    resetKmsClientForTests();
    const foreignEnvelope = await encryptField(
      KMS_TEST_ORG,
      '{"memories":[],"config":{},"workspaceFiles":{}}',
      KMS_TEST_COORDS,
    );
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "stale-unproven",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        state_data: {
          kind: "encrypted-agent-backup-state",
          algorithm: "kms-aes-256-gcm",
          ...foreignEnvelope,
        },
        state_data_storage: "inline",
        state_data_key: null,
        backup_kind: "full",
        parent_backup_id: null,
        content_hash: null,
        size_bytes: 2,
        verification_status: null,
        verified_at: null,
        verification_error: null,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
      } as never,
    );
    const stamp = spyOn(agentSandboxesRepository, "stampBackupVerification").mockResolvedValue(
      undefined as never,
    );
    const listMeta = spyOn(agentSandboxesRepository, "listBackupMetadata").mockResolvedValue(
      [] as never,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update");
    const svc = new ElizaSandboxService(provider);
    const authority = spyOn(
      svc as unknown as {
        revalidateContainerBackedLifecycleGeneration: () => Promise<AgentSandbox | undefined>;
      },
      "revalidateContainerBackedLifecycleGeneration",
    ).mockResolvedValue(rec);
    try {
      const result = await svc.executeSleep(rec.id, rec.organization_id);

      expect(result.success).toBe(false);
      expect(result.containerRemoved).toBe(false);
      expect(result.error).toContain("Refusing to deactivate on an unproven backup");
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      find.mockRestore();
      storedBackup.mockRestore();
      stamp.mockRestore();
      listMeta.mockRestore();
      updateSpy.mockRestore();
      authority.mockRestore();
    }
  });
});

describe("ElizaSandboxService sleep", () => {
  test("aborts deactivation when no durable backup can be created or found", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = customSandbox();
    const provider: SandboxProvider = {
      create: mock(async () => ({
        sandboxId: "agent-e06bb509",
        bridgeUrl: "https://runtime.example",
        healthUrl: "https://runtime.example/health",
      })),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    globalThis.fetch = mock(async () => {
      throw new Error("snapshot unavailable");
    });
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      rec,
    );
    const latestBackupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    // The gate consults the un-hydrated read; nothing durable exists.
    const storedBackupSpy = spyOn(
      agentSandboxesRepository,
      "getLatestStoredBackup",
    ).mockResolvedValue(undefined);
    const createBackupSpy = spyOn(agentSandboxesRepository, "createBackup");
    const updateSpy = spyOn(agentSandboxesRepository, "update");
    const svc = new ElizaSandboxService(provider);
    const authority = spyOn(
      svc as unknown as {
        revalidateContainerBackedLifecycleGeneration: () => Promise<AgentSandbox | undefined>;
      },
      "revalidateContainerBackedLifecycleGeneration",
    ).mockResolvedValue(rec);

    try {
      const result = await svc.executeSleep(rec.id, rec.organization_id);

      expect(result).toEqual({
        success: false,
        containerRemoved: false,
        error:
          "Unable to create or find a durable backup before deactivation; agent was left running.",
      });
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(createBackupSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      latestBackupSpy.mockRestore();
      storedBackupSpy.mockRestore();
      createBackupSpy.mockRestore();
      updateSpy.mockRestore();
      authority.mockRestore();
    }
  });
});

// C1b attribution guard (audit §C1b/§C5): provision() must NOT flip a docker-
// backed sandbox to `running` when the provider handle carries no durable
// node_id (metadata shape drift, or an empty-string nodeId). Such a row would be
// an unattributable orphan the node recount undercounts (#15378) and the orphan
// reconciler provably cannot reap (allHaveNodeAndStamp skips live null-node
// rows). The guard must fail LOUD + NON-retryable, and the container must be
// torn down per the standard post-create-failure convention.
describe("ElizaSandboxService provision — node attribution guard (C1b)", () => {
  function dedicatedProvisionTarget(): AgentSandbox {
    // A dedicated agent mid-provision: DB already ready (so provision() skips
    // provisionAgentDatabase), no node yet. Non-shared tier so the guard applies.
    return {
      ...customSandbox(),
      execution_tier: "dedicated-always",
      status: "provisioning",
      sandbox_id: null,
      bridge_url: null,
      health_url: null,
      node_id: null,
      container_name: null,
      bridge_port: null,
      web_ui_port: null,
      headscale_ip: null,
      environment_vars: {},
    };
  }

  async function runProvisionWithMetadata(metadata: Record<string, unknown>) {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = dedicatedProvisionTarget();
    const now = new Date("2026-07-07T12:00:00.000Z");

    const create = mock(async () => ({
      sandboxId: "agent-e06bb509",
      bridgeUrl: "https://runtime.example",
      healthUrl: "https://runtime.example/health",
      metadata,
    }));
    const stop = mock(async () => {});
    const provider = replacementAwareProvider({
      create,
      stop,
      checkHealth: mock(async () => true),
    } as SandboxProvider);

    // A 404 on GET /api/agents makes listRuntimeAgents report the runtime as
    // unsupported, so ensureRuntimeAgentStarted short-circuits (returns null)
    // and the success path proceeds straight to the running-flip (same shape
    // the wake suite uses to drive provision() offline).
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = fetchUrl(input);
      if (url.endsWith("/api/agents")) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({ ok: true });
    });

    const originalFindByIdAndOrg = agentSandboxesRepository.findByIdAndOrg;
    const originalTrySetProvisioning = agentSandboxesRepository.trySetProvisioning;
    const originalFindById = agentSandboxesRepository.findById;
    const originalGetLatestBackup = agentSandboxesRepository.getLatestBackup;
    // No snapshot to restore — keeps the success path free of the backup-restore
    // machinery (out of scope for the attribution guard).
    agentSandboxesRepository.getLatestBackup = mock(async () => undefined);
    agentSandboxesRepository.findByIdAndOrg = mock(async () => rec);
    agentSandboxesRepository.trySetProvisioning = mock(async () => ({
      ...rec,
      status: "provisioning",
    }));
    // markError re-reads via findById for the returned record.
    agentSandboxesRepository.findById = mock(async () => ({ ...rec, status: "error" }));
    // Direct property override (not spyOn) so it lands on the SAME singleton the
    // ?actual eliza-sandbox module holds — matching the other stubs above.
    const originalUpdate = agentSandboxesRepository.update;
    const updateSpy = mock(async (_id: string, data: Record<string, unknown>) => ({
      ...rec,
      ...data,
      updated_at: now,
    }));
    agentSandboxesRepository.update =
      updateSpy as unknown as typeof agentSandboxesRepository.update;
    // prepareManagedElizaEnvironment mints an agent API key via createForAgent,
    // whose revoke path calls dbWrite.delete — unsupported by this file's
    // transaction-only dbWrite swap. Stub it like the wake suite does so
    // provision() reaches the guard without touching a real DB.
    const createForAgentSpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });

    try {
      const result = await new ElizaSandboxService(provider).provision(rec.id, rec.organization_id);
      return { result, create, stop, updateSpy };
    } finally {
      agentSandboxesRepository.findByIdAndOrg = originalFindByIdAndOrg;
      agentSandboxesRepository.trySetProvisioning = originalTrySetProvisioning;
      agentSandboxesRepository.findById = originalFindById;
      agentSandboxesRepository.update = originalUpdate;
      agentSandboxesRepository.getLatestBackup = originalGetLatestBackup;
      createForAgentSpy.mockRestore();
    }
  }

  test.skipIf(process.platform === "win32")(
    "docker-backed handle with EMPTY nodeId: no running+null row, non-retryable, container stopped",
    async () => {
      const { result, create, stop, updateSpy } = await runProvisionWithMetadata({
        // Docker-backed by provider tag, but the strict guard fails (empty
        // nodeId) so dockerMeta is undefined — the exact C1b drift.
        provider: "docker",
        nodeId: "",
        hostname: "host-1",
        containerName: "agent-e06bb509",
        bridgePort: 21060,
        webUiPort: 3000,
      });

      // Provision fails (not a fabricated success).
      expect(result.success).toBe(false);

      // NEVER minted a running row.
      for (const call of updateSpy.mock.calls) {
        expect((call[1] as { status?: string }).status).not.toBe("running");
      }

      // markError ran with the distinguishable, non-retryable prefix.
      const errorUpdate = updateSpy.mock.calls.find(
        (c) => (c[1] as { status?: string }).status === "error",
      );
      expect(errorUpdate).toBeDefined();
      if (!errorUpdate) {
        throw new Error("Expected the empty-node attribution error update");
      }
      expect((errorUpdate[1] as { error_message?: string }).error_message).toContain(
        "provision attribution guard:",
      );

      // Non-retryable: the guard message matches none of the port-collision
      // retry patterns, so create() ran exactly once (no retry loop).
      expect(create).toHaveBeenCalledTimes(1);

      // Container torn down per the post-create-failure convention (not leaked,
      // not left invisible-but-alive).
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "docker-backed handle with MISSING fields (type-guard miss): same refusal",
    async () => {
      const { result, create, stop, updateSpy } = await runProvisionWithMetadata({
        // Provider tag present but hostname/containerName absent => strict guard
        // fails => dockerMeta undefined, yet it IS docker-backed.
        provider: "docker",
        nodeId: "node-1",
      });

      expect(result.success).toBe(false);
      for (const call of updateSpy.mock.calls) {
        expect((call[1] as { status?: string }).status).not.toBe("running");
      }
      const errorUpdate = updateSpy.mock.calls.find(
        (c) => (c[1] as { status?: string }).status === "error",
      );
      expect(errorUpdate).toBeDefined();
      if (!errorUpdate) {
        throw new Error("Expected the incomplete-metadata attribution error update");
      }
      expect((errorUpdate[1] as { error_message?: string }).error_message).toContain(
        "provision attribution guard:",
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "docker-backed handle WITH a real nodeId: flips running normally (guard does not misfire)",
    async () => {
      const { result, updateSpy } = await runProvisionWithMetadata({
        provider: "docker",
        nodeId: "node-1",
        hostname: "host-1",
        containerName: "agent-e06bb509",
        bridgePort: 21060,
        webUiPort: 3000,
        dockerImage: "ghcr.io/example/bnancy:latest",
        imageDigest: null,
      });

      expect(result.success).toBe(true);
      const runningUpdate = updateSpy.mock.calls.find(
        (c) => (c[1] as { status?: string }).status === "running",
      );
      expect(runningUpdate).toBeDefined();
      if (!runningUpdate) {
        throw new Error("Expected the running sandbox update");
      }
      expect((runningUpdate[1] as { node_id?: string }).node_id).toBe("node-1");
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

  test("a 503 from /api/snapshot remains a retryable transient sentinel", async () => {
    const { ElizaSandboxService, SNAPSHOT_CAPTURE_TRANSIENT } = await import(
      "./eliza-sandbox.ts?actual"
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
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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

describe("ElizaSandboxService recoverDisconnected", () => {
  function disconnectedSandbox(): AgentSandbox {
    return { ...customSandbox(), status: "disconnected" };
  }

  test("a forged Shared row is rejected before bridge, SSH, or write effects", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...disconnectedSandbox(),
      execution_tier: "shared",
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      sandbox,
    );
    const replicaSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg");
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockResolvedValue(undefined);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
      undefined as never,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(undefined);
    const sshSpy = spyOn(DockerSSHClient, "getClient").mockReturnValue({
      exec: mock(async () => "must not execute"),
    } as unknown as DockerSSHClient);
    const bridgeFetch = mock(async () => new Response("must not probe", { status: 200 }));
    globalThis.fetch = bridgeFetch;

    try {
      await expect(
        new ElizaSandboxService().recoverDisconnected(sandbox.id, sandbox.organization_id),
      ).resolves.toBe("gone");
      expect(primarySpy).toHaveBeenCalledTimes(1);
      expect(replicaSpy).not.toHaveBeenCalled();
      expect(bridgeFetch).not.toHaveBeenCalled();
      expect(nodeSpy).not.toHaveBeenCalled();
      expect(sshSpy).not.toHaveBeenCalled();
      expect(casSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
      replicaSpy.mockRestore();
      casSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
      sshSpy.mockRestore();
    }
  });

  test("recovers a reachable disconnected agent via guarded compare-and-set", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
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
      expect(casSpy.mock.calls[0]).toEqual([sandbox]);
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
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
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
      expect(casSpy.mock.calls[0]).toEqual([sandbox]);
    } finally {
      findSpy.mockRestore();
      casSpy.mockRestore();
    }
  });

  test("does NOT revive when the row left disconnected mid-probe (CAS loses -> gone)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = disconnectedSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
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
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
      async () => sandbox,
    );
    const casSpy = spyOn(
      agentSandboxesRepository,
      "markReconnectedFromDisconnected",
    ).mockImplementation(async () => undefined);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(undefined);
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
      nodeSpy.mockRestore();
    }
    // The unreachable path burns real probe-retry backoff (~5-6s of sleeps);
    // under the multi-suite coverage lane that overruns the default 5s budget.
  }, 20_000);

  test("reports gone (and never probes) when the row is no longer disconnected", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockImplementation(
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

describe("ElizaSandboxService unresolved replacement fence authority", () => {
  for (const executionTier of ["shared", "future-container-tier"] as const) {
    test(`rejects ${executionTier} observed under the lock before enrichment CAS`, async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const current: AgentSandbox = {
        ...customSandbox(),
        execution_tier: executionTier as AgentSandbox["execution_tier"],
        replacement_cleanup_sandbox_id: "replacement-sandbox",
        replacement_cleanup_node_id: "replacement-node",
        replacement_cleanup_container_name: "replacement-container",
        replacement_cleanup_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        replacement_cleanup_container_id: null,
        replacement_cleanup_vpn_node_id: null,
        replacement_cleanup_vpn_node_name: null,
        replacement_cleanup_preserved_vpn_node_id: null,
        replacement_cleanup_vpn_registration_started_at: null,
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date("2026-08-24T00:00:00.000Z"),
      };
      const unresolved = new SandboxReplacementCleanupUnresolvedError(
        {
          sandboxId: "replacement-sandbox",
          nodeId: "replacement-node",
          containerName: "replacement-container",
          replacementAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          containerId: "sha256:resolved-after-error",
          allocationCounted: true,
        },
        new Error("node transport unresolved"),
      );
      type FenceService = {
        persistUnresolvedReplacementCleanupFence(
          agentId: string,
          orgId: string,
          error: SandboxReplacementCleanupUnresolvedError,
        ): Promise<void>;
        lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
        getAgentForLifecycleMutation(
          tx: unknown,
          agentId: string,
          orgId: string,
        ): Promise<AgentSandbox | undefined>;
      };
      const svc = new ElizaSandboxService() as unknown as FenceService;
      const lock = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
      const read = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(current);
      let rawWrites = 0;
      upgradeTransactionImpl = async (fn) =>
        fn({
          execute: async () => {
            rawWrites += 1;
            return { rows: [] };
          },
        });
      try {
        await expect(
          svc.persistUnresolvedReplacementCleanupFence(
            current.id,
            current.organization_id,
            unresolved,
          ),
        ).rejects.toThrow("requires a container-backed execution tier");
        expect(rawWrites).toBe(0);
      } finally {
        upgradeTransactionImpl = null;
        lock.mockRestore();
        read.mockRestore();
      }
    });
  }
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
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(undefined);
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
      nodeSpy.mockRestore();
    }
  });

  test("probe that succeeds on a retry bumps last_heartbeat_at and leaves status alone", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
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

  test("a successful probe cannot write through a concurrent delete intent", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(undefined);
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [id, patch, expectedGeneration] = updateSpy.mock.calls[0];
      expect(id).toBe(sandbox.id);
      expect(patch.last_heartbeat_at).toBeInstanceOf(Date);
      expect(expectedGeneration).toEqual({
        organizationId: sandbox.organization_id,
        environmentRevision: sandbox.environment_revision,
        sandboxId: sandbox.sandbox_id,
        nodeId: sandbox.node_id,
        containerName: sandbox.container_name,
        lifecycleRevision: sandbox.lifecycle_revision,
      });
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("terminal database liveness failure enqueues a bounded restart", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-db-liveness-restart" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          status: "unhealthy",
          database: "terminal_error",
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.error_count).toBe(1);
      expect(String(patch.error_message)).toContain("[db-liveness-restart]");
      expect(enqueueSpy).toHaveBeenCalledWith({
        agentId: sandbox.id,
        organizationId: sandbox.organization_id,
        userId: sandbox.user_id,
      });
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("a terminal probe cannot enqueue recovery after concurrent deletion takes ownership", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(undefined);
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockResolvedValue({
      created: true,
      job: { id: "job-must-not-start" },
    } as never);
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      await expect(
        new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id),
      ).resolves.toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("transient database liveness failures do not enqueue an immediate restart", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-should-not-start" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "healthy",
        database: "transient_error",
        databaseLiveness: {
          ok: false,
          status: "transient_error",
          terminal: false,
          message: "temporary probe timeout",
        },
      }),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("unrelated error_count does not consume the database-liveness restart budget", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      error_count: 9,
      error_message: "tailnet reconciliation failures",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-db-budget-isolated" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.error_count).toBe(1);
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("database-liveness restart cooldown suppresses duplicate enqueue", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      error_count: 1,
      error_message: `[db-liveness-restart] count=1 at=${new Date().toISOString()} reason=PGlite is closed`,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-duplicate" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "Database is shutting down - operation rejected",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("database-liveness restart budget exhausts to error instead of looping", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      error_count: 3,
      error_message: `[db-liveness-restart] count=3 at=${new Date(Date.now() - 20 * 60_000).toISOString()} reason=PGlite is closed`,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-budget-exhausted" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("error");
      expect(patch.error_count).toBe(3);
      expect(String(patch.error_message)).toContain("budget-exhausted");
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("database-liveness restart budget is isolated per agent record", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const exhausted: AgentSandbox = {
      ...customSandbox(),
      id: "11111111-1111-4111-8111-111111111111",
      error_count: 3,
      error_message: `[db-liveness-restart] count=3 at=${new Date(Date.now() - 20 * 60_000).toISOString()} reason=PGlite is closed`,
    };
    const fresh: AgentSandbox = {
      ...customSandbox(),
      id: "22222222-2222-4222-8222-222222222222",
      error_count: 3,
      error_message: "unrelated launch failures",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async (agentId) => (agentId === exhausted.id ? exhausted : fresh),
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (agentId, updates) =>
        ({
          ...(agentId === exhausted.id ? exhausted : fresh),
          ...updates,
        }) as AgentSandbox,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-agent-isolated" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      await expect(
        new ElizaSandboxService().heartbeat(exhausted.id, exhausted.organization_id),
      ).resolves.toBe(false);
      await expect(
        new ElizaSandboxService().heartbeat(fresh.id, fresh.organization_id),
      ).resolves.toBe(false);

      expect(updateSpy).toHaveBeenCalledTimes(2);
      expect(updateSpy.mock.calls[0][1]).toMatchObject({
        status: "error",
        error_count: 3,
      });
      expect(updateSpy.mock.calls[1][1]).toMatchObject({
        error_count: 1,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith({
        agentId: fresh.id,
        organizationId: fresh.organization_id,
        userId: fresh.user_id,
      });
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
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
  const STALE_HEALTH = `http://${OLD_IP}:3000/api`;
  const REPAIRED_HEALTH = `http://${NEW_IP}:3000/api`;

  function staleIpSandbox(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
    return {
      ...customSandbox(),
      bridge_url: STALE_BRIDGE,
      health_url: STALE_HEALTH,
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
      allocated_count: 1,
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
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
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
      expect(patch.health_url).toBe(REPAIRED_HEALTH);
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

  test("(c2) heartbeat: only repairs a coherent prior tailnet generation", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const invalidGenerations: Partial<AgentSandbox>[] = [
      { headscale_ip: null },
      { health_url: "http://100.64.0.12:3000/api" },
      { health_url: `http://${OLD_IP}:3001/api` },
    ];

    for (const invalidGeneration of invalidGenerations) {
      const sandbox = staleIpSandbox(invalidGeneration);
      const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
        sandbox,
      );
      const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(
        undefined as never,
      );
      const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(nodeRecord());
      const { getClientSpy } = mockNodeSsh({ health: "healthy", tailscaleIp: NEW_IP });
      fetchAliveOnlyOnNewIp();

      try {
        const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
        expect(ok).toBe(false);
        expect(updateSpy).toHaveBeenCalledTimes(1);
        const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(patch.status).toBe("disconnected");
        expect(patch.headscale_ip).toBeUndefined();
        expect(patch.bridge_url).toBeUndefined();
        expect(patch.health_url).toBeUndefined();
      } finally {
        findSpy.mockRestore();
        updateSpy.mockRestore();
        nodeSpy.mockRestore();
        getClientSpy.mockRestore();
      }
    }
  }, 30_000);

  test("(d) heartbeat: docker-healthy + IP unresolvable guards error_count and escalates to disconnected on the 3rd cycle", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    // error_count evolves across cycles the way the guard writes it.
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
      // Cycles 1 and 2: still running, error_count guards, NO disconnect.
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
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      sandbox,
    );
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
      expect(casSpy.mock.calls[0]).toEqual([
        sandbox,
        {
          headscaleIp: NEW_IP,
          bridgeUrl: REPAIRED_BRIDGE,
          healthUrl: REPAIRED_HEALTH,
          errorCount: 0,
        },
      ]);
      // Repaired ingress is part of the same generation CAS. A second generic
      // update could otherwise write A's URL/IP onto a stopped or replaced B.
      expect(updateSpy).not.toHaveBeenCalled();
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
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      sandbox,
    );
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

  test("a running row with a non-container tier fails before billing or provisioning", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue({
      ...resumeRow("running"),
      execution_tier: "shared",
    });
    settleLifecycleBillingSpy.mockClear();
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toEqual({
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Sandbox provisioning requires an explicit container-backed execution tier",
      });
      expect(settleLifecycleBillingSpy).not.toHaveBeenCalled();
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

  test("insufficient accrued debt blocks resume before provider provisioning", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      resumeRow("stopped"),
    );
    settleLifecycleBillingSpy.mockResolvedValueOnce({ status: "insufficient_credits" });
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeResume(RESUME_AGENT, RESUME_ORG);
      expect(res).toMatchObject({
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Insufficient credits to settle accrued agent compute charges",
      });
      expect(provisionSpy).not.toHaveBeenCalled();
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

  test("executeRestart propagates a transient fail-closed snapshot result", async () => {
    const { ElizaSandboxService, SNAPSHOT_CAPTURE_TRANSIENT } = await import(
      "./eliza-sandbox.ts?actual"
    );
    const svc = new ElizaSandboxService();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      row("running"),
    );
    const shutdownSpy = spyOn(svc, "shutdown").mockResolvedValue({
      success: false,
      retryable: true,
      error: `Refusing to stop without a current backup: ${SNAPSHOT_CAPTURE_TRANSIENT}`,
    });
    const provisionSpy = spyOn(svc, "provision");
    try {
      const res = await svc.executeRestart(AGENT, ORG);
      expect(res).toMatchObject({
        success: false,
        retryable: true,
        containerStopped: false,
        containerStarted: false,
      });
      expect(provisionSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      shutdownSpy.mockRestore();
      provisionSpy.mockRestore();
    }
  });
});

describe("replacement lifecycle teardown is absence-proof", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  function claimedPendingRow(): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      status: "running",
      claimed_at: new Date("2026-07-23T00:00:00.000Z"),
      warm_claim_credential_state: "pending",
      sandbox_id: "warm-live-container",
      node_id: "unreachable-node",
      container_name: "warm-live-container",
      bridge_url: null,
      health_url: null,
    };
  }

  test("restart on an unreachable old node preserves the handle and never provisions", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = claimedPendingRow();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {
        throw new Error("old node unreachable");
      }),
      checkHealth: mock(async () => true),
    };
    type LifecycleSvc = {
      executeRestart(
        agentId: string,
        orgId: string,
      ): Promise<{
        success: boolean;
        error?: string;
      }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
      provision(agentId: string, orgId: string): Promise<unknown>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as LifecycleSvc;
    const getForWrite = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const lockLifecycleSpy = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(rec);
    const activeJob = spyOn(svc, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const provision = spyOn(svc, "provision");
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = await svc.executeRestart(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Failed to prove the previous sandbox stopped",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(provision).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      getForWrite.mockRestore();
      lockLifecycleSpy.mockRestore();
      getForMutation.mockRestore();
      activeJob.mockRestore();
      provision.mockRestore();
    }
  });

  test("legacy warm recovery with no compute handle reaches cold provision", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "provisioning",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("provision is spied");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type RestartSvc = {
      executeRestart(
        agentId: string,
        orgId: string,
      ): Promise<{
        success: boolean;
        containerStopped: boolean;
        containerStarted: boolean;
      }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
      provision(
        agentId: string,
        orgId: string,
      ): Promise<{
        success: true;
        sandboxRecord: AgentSandbox;
        bridgeUrl: string;
        healthUrl: string;
      }>;
      recoverPendingWarmClaimInferenceKey(
        agentId: string,
        orgId: string,
      ): Promise<{ pushed: boolean }>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as RestartSvc;
    const getForWrite = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(rec);
    const activeProvision = spyOn(svc, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const provision = spyOn(svc, "provision").mockResolvedValue({
      success: true,
      sandboxRecord: { ...rec, status: "running" },
      bridgeUrl: "https://replacement.example",
      healthUrl: "https://replacement.example/api",
    });
    const recoverCredential = spyOn(svc, "recoverPendingWarmClaimInferenceKey").mockResolvedValue({
      pushed: true,
    });
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = await svc.executeRestart(AGENT, ORG);
      expect(result).toEqual({
        success: true,
        containerStopped: true,
        containerStarted: true,
        bridgeUrl: "https://replacement.example",
        healthUrl: "https://replacement.example/api",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(1);
      expect(provision).toHaveBeenCalledWith(AGENT, ORG);
      expect(recoverCredential).toHaveBeenCalledWith(AGENT, ORG);
    } finally {
      upgradeTransactionImpl = null;
      getForWrite.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      provision.mockRestore();
      recoverCredential.mockRestore();
    }
  });

  test("legacy warm recovery with a partial locator fails closed", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "provisioning",
      sandbox_id: null,
      node_id: "orphan-node",
      container_name: null,
      bridge_url: null,
      health_url: null,
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    type ShutdownSvc = {
      shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as ShutdownSvc;
    const getForWrite = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(rec);
    const activeProvision = spyOn(svc, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      expect(await svc.shutdown(AGENT, ORG)).toEqual({
        success: false,
        error: "Warm-claim recovery locator is incomplete",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally {
      upgradeTransactionImpl = null;
      getForWrite.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
    }
  });

  test("suspend on an unreachable old node does not write stopped state", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = claimedPendingRow();
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {
        throw new Error("old node unreachable");
      }),
      checkHealth: mock(async () => true),
    };
    type SuspendSvc = {
      executeSuspend(
        agentId: string,
        orgId: string,
        jobId: string,
      ): Promise<{
        success: boolean;
        containerStopped: boolean;
        backupId?: string;
        error?: string;
      }>;
      getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
      prepareSuspendBackupGate(
        rec: AgentSandbox,
      ): Promise<
        | { outcome: "skip" }
        | { outcome: "proceed"; backupId?: string; capturedFresh: boolean }
        | { outcome: "refuse"; error: string }
      >;
      lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
      getAgentForLifecycleMutation(
        tx: unknown,
        agentId: string,
        orgId: string,
      ): Promise<AgentSandbox | undefined>;
      hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
    };
    const svc = new ElizaSandboxService(provider) as unknown as SuspendSvc;
    const getForWriteSpy = spyOn(svc, "getAgentForWrite").mockResolvedValue(rec);
    const gateSpy = spyOn(svc, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      capturedFresh: false,
    });
    const lockLifecycleSpy = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(rec);
    const activeJob = spyOn(svc, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const writes: unknown[] = [];
    let selectCount = 0;
    upgradeTransactionImpl = async (fn) => {
      const tx = {
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: async () => {
                  selectCount += 1;
                  if (selectCount === 1) {
                    return [
                      {
                        id: "00000000-0000-0000-0000-000000000098",
                        organization_id: ORG,
                        agent_id: AGENT,
                        lifecycle_revision: rec.lifecycle_revision,
                        status: "pending",
                        job_id: "00000000-0000-0000-0000-000000000099",
                        attempts: 0,
                      },
                    ];
                  }
                  return [{ credit_balance: "0" }];
                },
              }),
            }),
          }),
        }),
        update: () => ({ set: () => ({ where: async () => [] }) }),
      };
      return fn(tx);
    };

    try {
      const result = await svc.executeSuspend(AGENT, ORG, "00000000-0000-0000-0000-000000000099");
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: "old node unreachable",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(writes).toHaveLength(0);
    } finally {
      upgradeTransactionImpl = null;
      getForWriteSpy.mockRestore();
      gateSpy.mockRestore();
      lockLifecycleSpy.mockRestore();
      getForMutation.mockRestore();
      activeJob.mockRestore();
    }
  });

  // Pre-suspend backup gate (#20726 item 6): the provider stop drops the
  // container, so suspend must prove a durable backup first, exactly like
  // sleep and delete. These tests drive the real gate with a mocked bridge
  // capture and repository fixtures.
  type SuspendGateSvc = {
    executeSuspend(
      agentId: string,
      orgId: string,
      jobId: string,
      authorization?: "user_request" | "billing_request",
      expectedLifecycleRevision?: number,
    ): Promise<{
      success: boolean;
      containerStopped: boolean;
      backupId?: string;
      error?: string;
      skipped?: boolean;
      reason?: string;
    }>;
    prepareSuspendBackupGate(rec: AgentSandbox): Promise<
      | { outcome: "skip" }
      | {
          outcome: "proceed";
          backupId?: string;
          capturedFresh: boolean;
          pendingSnapshot?: { stateData: unknown; sizeBytes: number };
        }
      | { outcome: "refuse"; error: string }
    >;
    revalidateContainerBackedLifecycleGeneration(
      rec: AgentSandbox,
      action: string,
    ): Promise<AgentSandbox | undefined>;
    getAgentForWrite(agentId: string, orgId: string): Promise<AgentSandbox | undefined>;
    fetchSnapshotState(
      rec: AgentSandbox,
    ): Promise<{ stateData: unknown; sizeBytes: number; bridgeUrl: string }>;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
    hasActiveProvisionJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
    persistSnapshotWithinTransaction(
      tx: unknown,
      sandboxRecordId: string,
      organizationId: string,
      type: string,
      stateData: unknown,
      sizeBytes: number,
    ): Promise<{ backupId: string; lifecycleRevision: number }>;
  };

  function bridgedRunningRow(): AgentSandbox {
    return {
      ...claimedPendingRow(),
      bridge_url: "https://bridge.example",
      health_url: "https://bridge.example/api",
    };
  }

  async function suspendSvc(
    rec: AgentSandbox,
    provider: SandboxProvider,
    lockedRec: AgentSandbox = rec,
  ) {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService(provider) as unknown as SuspendGateSvc;
    const spies = [
      spyOn(svc, "getAgentForWrite").mockResolvedValue(rec),
      spyOn(svc, "revalidateContainerBackedLifecycleGeneration").mockResolvedValue(rec),
      spyOn(svc, "lockLifecycle").mockResolvedValue(undefined),
      spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(lockedRec),
      spyOn(svc, "hasActiveProvisionJobTx").mockResolvedValue(false),
    ];
    return { svc, restore: () => spies.forEach((s) => s.mockRestore()) };
  }

  function stoppableProvider(): SandboxProvider {
    return {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
  }

  const SUSPEND_JOB = "00000000-0000-0000-0000-000000000099";

  test("a funded user suspend settles compute and keeps its fresh backup billable", async () => {
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockResolvedValue({
      stateData: { memories: [] },
      sizeBytes: 42,
      bridgeUrl: rec.bridge_url as string,
    });
    const persistSpy = spyOn(svc, "persistSnapshotWithinTransaction").mockResolvedValue({
      backupId: "backup-fresh",
      lifecycleRevision: rec.lifecycle_revision + 1,
    });
    const createSpy = spyOn(agentSandboxesRepository, "createBackup");
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(undefined);
    const writes: SQL[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query as SQL);
          return { rows: [] };
        },
      });
    try {
      settleLifecycleBillingInTransactionSpy.mockClear();
      settleLifecycleBillingInTransactionSpy.mockResolvedValueOnce({
        status: "billed",
        amount: 0.01,
      });
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({ success: true, containerStopped: true, backupId: "backup-fresh" });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(persistSpy).toHaveBeenCalledWith(
        expect.anything(),
        rec.id,
        rec.organization_id,
        "pre-shutdown",
        { memories: [] },
        42,
      );
      expect(createSpy).not.toHaveBeenCalled();
      expect(pruneSpy).toHaveBeenCalledWith(AGENT, 10);
      expect(settleLifecycleBillingInTransactionSpy).toHaveBeenCalledWith(
        expect.anything(),
        AGENT,
        ORG,
        expect.any(Date),
      );
      expect(writes).toHaveLength(1);
      const query = new PgDialect().sqlToQuery(writes[0]);
      const rendered = query.sql;
      expect(rendered).toContain("last_backup_at = NOW()");
      expect(query.params).toContain("active");
    } finally {
      upgradeTransactionImpl = null;
      fetchSpy.mockRestore();
      persistSpy.mockRestore();
      createSpy.mockRestore();
      pruneSpy.mockRestore();
      restore();
    }
  });

  test("suspend defers on a transient capture signal without touching compute", async () => {
    const { SNAPSHOT_CAPTURE_TRANSIENT } = await import("./eliza-sandbox.ts?actual");
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_CAPTURE_TRANSIENT),
    );
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: `Refusing to stop without a current backup: ${SNAPSHOT_CAPTURE_TRANSIENT}`,
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      restore();
    }
  });

  test("a no-snapshot-endpoint image suspends only on a proven existing backup", async () => {
    const { SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import("./eliza-sandbox.ts?actual");
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue({
      id: "backup-proven",
      sandbox_record_id: rec.id,
      snapshot_type: "scheduled",
      created_at: new Date(),
      verification_status: "verified",
      verified_at: new Date(),
      verification_error: null,
    } as StoredAgentSandboxBackup);
    const writes: SQL[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query as SQL);
          return { rows: [] };
        },
      });
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: true,
        containerStopped: true,
        backupId: "backup-proven",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      const rendered = new PgDialect().sqlToQuery(writes[0]).sql;
      expect(rendered).not.toContain("last_backup_at");
    } finally {
      upgradeTransactionImpl = null;
      fetchSpy.mockRestore();
      latestSpy.mockRestore();
      restore();
    }
  });

  test("a no-snapshot-endpoint image with no durable backup refuses to suspend", async () => {
    const { SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import("./eliza-sandbox.ts?actual");
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
      new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      undefined,
    );
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: "Unable to create or find a durable backup before stopping; agent was left running.",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      latestSpy.mockRestore();
      restore();
    }
  });

  test("capture failure falls back to a proven restorable existing backup", async () => {
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const fetchSpy = spyOn(svc, "fetchSnapshotState").mockRejectedValue(
      new Error("bridge reset mid-stream"),
    );
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue({
      id: "backup-proven",
      sandbox_record_id: rec.id,
      snapshot_type: "scheduled",
      created_at: new Date(),
      verification_status: "verified",
      verified_at: new Date(),
      verification_error: null,
    } as StoredAgentSandboxBackup);
    const writes: SQL[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query as SQL);
          return { rows: [] };
        },
      });
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: true,
        containerStopped: true,
        backupId: "backup-proven",
      });
      const rendered = new PgDialect().sqlToQuery(writes[0]).sql;
      expect(rendered).not.toContain("last_backup_at");
    } finally {
      upgradeTransactionImpl = null;
      fetchSpy.mockRestore();
      latestSpy.mockRestore();
      restore();
    }
  });

  test("suspend refuses when no durable backup exists and none can be captured", async () => {
    const rec = claimedPendingRow(); // running, no bridge to capture from
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const latestSpy = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      undefined,
    );
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: "Unable to create or find a durable backup before stopping; agent was left running.",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      latestSpy.mockRestore();
      restore();
    }
  });

  test("suspend refuses when the lifecycle moved between capture and lock", async () => {
    const rec = bridgedRunningRow();
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    const gateSpy = spyOn(svc, "prepareSuspendBackupGate").mockResolvedValue({
      outcome: "proceed",
      backupId: "backup-fresh",
      capturedFresh: true,
    });
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue({
      ...rec,
      lifecycle_revision: rec.lifecycle_revision + 1,
    });
    const writes: SQL[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query as SQL);
          return { rows: [] };
        },
      });
    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB);
      expect(result).toEqual({
        success: false,
        containerStopped: false,
        error: "Agent lifecycle changed while the suspend backup was prepared",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    } finally {
      upgradeTransactionImpl = null;
      gateSpy.mockRestore();
      getForMutation.mockRestore();
      restore();
    }
  });

  test.each([
    ["status", "disconnected"],
    ["node_id", "replacement-node"],
    ["container_name", "replacement-container"],
    ["health_url", "https://replacement.example/api"],
  ] as const)(
    "suspend refuses when %s changes between capture and lock",
    async (field, replacement) => {
      const rec = bridgedRunningRow();
      const provider = stoppableProvider();
      const { svc, restore } = await suspendSvc(rec, provider, {
        ...rec,
        [field]: replacement,
      });
      const gateSpy = spyOn(svc, "prepareSuspendBackupGate").mockResolvedValue({
        outcome: "proceed",
        backupId: "backup-fresh",
        capturedFresh: true,
      });
      const writes: SQL[] = [];
      upgradeTransactionImpl = async (fn) =>
        fn({
          execute: async (query) => {
            writes.push(query as SQL);
            return { rows: [] };
          },
        });
      try {
        await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
          success: false,
          containerStopped: false,
          error: "Agent lifecycle changed while the suspend backup was prepared",
        });
        expect(provider.stopForReplacement).not.toHaveBeenCalled();
        expect(writes).toHaveLength(0);
      } finally {
        upgradeTransactionImpl = null;
        gateSpy.mockRestore();
        restore();
      }
    },
  );

  test("suspend rejects a Shared tier under the lock before provider stop or write", async () => {
    const rec = { ...bridgedRunningRow(), status: "stopped" as const, bridge_url: null };
    const locked = { ...rec, execution_tier: "shared" as const };
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider, locked);
    let writeCalled = false;
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => {
          writeCalled = true;
          return { rows: [] };
        },
      });
    try {
      await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
        success: false,
        containerStopped: false,
        error: "Agent suspend requires a container-backed execution tier",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(writeCalled).toBe(false);
    } finally {
      upgradeTransactionImpl = null;
      restore();
    }
  });

  test("suspend running→Shared checkpoint race performs no capture, backup stamp, provider stop, or write", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const initial = bridgedRunningRow();
    const shared: AgentSandbox = { ...initial, execution_tier: "shared" };
    const provider = stoppableProvider();
    const svc = new ElizaSandboxService(provider) as unknown as SuspendGateSvc;
    const primary = spyOn(svc, "getAgentForWrite").mockResolvedValue(initial);
    const lock = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const lockedRead = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(shared);
    const capture = spyOn(svc, "fetchSnapshotState");
    const createBackup = spyOn(agentSandboxesRepository, "createBackup");
    const stamp = spyOn(agentSandboxesRepository, "stampBackupVerification");
    let rawWrites = 0;
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => {
          rawWrites += 1;
          return { rows: [] };
        },
      });
    try {
      await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
        success: false,
        containerStopped: false,
        error: "Agent lifecycle changed while the suspend backup was prepared",
      });
      expect(capture).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
      expect(stamp).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(rawWrites).toBe(0);
    } finally {
      upgradeTransactionImpl = null;
      primary.mockRestore();
      lock.mockRestore();
      lockedRead.mockRestore();
      capture.mockRestore();
      createBackup.mockRestore();
      stamp.mockRestore();
    }
  });

  test("suspend gate skips shared-tier and container-less rows", async () => {
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(claimedPendingRow(), provider);
    try {
      expect(
        await svc.prepareSuspendBackupGate({ ...claimedPendingRow(), execution_tier: "shared" }),
      ).toEqual({ outcome: "skip" });
      expect(
        await svc.prepareSuspendBackupGate({ ...claimedPendingRow(), sandbox_id: null }),
      ).toEqual({ outcome: "skip" });
    } finally {
      restore();
    }
  });

  test("a funded billing stop for an already-stopped agent stays billable", async () => {
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "stopped",
      billing_status: "shutdown_pending",
      last_backup_at: new Date("2026-08-20T00:00:00.000Z"),
    };
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    settleLifecycleBillingInTransactionSpy.mockClear();
    settleLifecycleBillingInTransactionSpy.mockResolvedValueOnce({
      status: "already_billed_recently",
    });
    const updates: Array<Record<string, unknown>> = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: async () => [
                  {
                    id: "00000000-0000-0000-0000-000000000098",
                    organization_id: ORG,
                    agent_id: AGENT,
                    lifecycle_revision: rec.lifecycle_revision,
                    authorization: "billing_request",
                    status: "pending",
                    job_id: SUSPEND_JOB,
                    attempts: 0,
                  },
                ],
              }),
            }),
          }),
        }),
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { where: async () => [] };
          },
        }),
      } as never);

    try {
      const result = await svc.executeSuspend(AGENT, ORG, SUSPEND_JOB, "billing_request");
      expect(result).toEqual({
        success: true,
        containerStopped: false,
        skipped: true,
        reason: "billing_recovered",
      });
      expect(settleLifecycleBillingInTransactionSpy).toHaveBeenCalledWith(
        expect.anything(),
        AGENT,
        ORG,
        expect.any(Date),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({ status: "superseded", last_error: "billing_recovered" }),
      );
      expect(updates).toContainEqual(expect.objectContaining({ billing_status: "active" }));
      expect(updates.some((patch) => patch.billing_status === "suspended")).toBe(false);
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      restore();
    }
  });

  test("an unfunded user stop preserves retained-backup debt and billing authority", async () => {
    const rec: AgentSandbox = {
      ...claimedPendingRow(),
      status: "stopped",
      billing_status: "active",
      last_backup_at: new Date("2026-08-20T00:00:00.000Z"),
    };
    const provider = stoppableProvider();
    const { svc, restore } = await suspendSvc(rec, provider);
    settleLifecycleBillingInTransactionSpy.mockClear();
    settleLifecycleBillingInTransactionSpy.mockResolvedValueOnce({
      status: "insufficient_credits",
    });
    const updates: Array<Record<string, unknown>> = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return { where: async () => [] };
          },
        }),
      } as never);

    try {
      await expect(svc.executeSuspend(AGENT, ORG, SUSPEND_JOB)).resolves.toEqual({
        success: true,
        containerStopped: true,
      });
      expect(settleLifecycleBillingInTransactionSpy).toHaveBeenCalledWith(
        expect.anything(),
        AGENT,
        ORG,
        expect.any(Date),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({
          billing_status: "active",
          scheduled_shutdown_at: null,
          shutdown_warning_sent_at: null,
        }),
      );
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      restore();
    }
  });

  type SleepSvc = {
    executeSleep(
      agentId: string,
      orgId: string,
    ): Promise<{
      success: boolean;
      containerRemoved: boolean;
      backupId?: string;
      error?: string;
    }>;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
    hasActiveReplacementJobTx(tx: unknown, agentId: string, orgId: string): Promise<boolean>;
  };

  function armSleepTransaction(
    svc: SleepSvc,
    current: AgentSandbox,
  ): {
    lockLifecycle: ReturnType<typeof spyOn>;
    getForMutation: ReturnType<typeof spyOn>;
    activeReplacement: ReturnType<typeof spyOn>;
    writes: unknown[];
  } {
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(current);
    const activeReplacement = spyOn(svc, "hasActiveReplacementJobTx").mockResolvedValue(false);
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [{ id: current.id }] };
        },
      });
    return { lockLifecycle, getForMutation, activeReplacement, writes };
  }

  test("sleep running→Shared checkpoint race performs no capture, backup stamp, provider stop, or write", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const initial = bridgedRunningRow();
    const shared: AgentSandbox = { ...initial, execution_tier: "shared" };
    const provider = stoppableProvider();
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const primary = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      initial,
    );
    const lock = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const lockedRead = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(shared);
    const capture = spyOn(
      svc as unknown as { fetchSnapshotState: () => Promise<unknown> },
      "fetchSnapshotState",
    );
    const createBackup = spyOn(agentSandboxesRepository, "createBackup");
    const stamp = spyOn(agentSandboxesRepository, "stampBackupVerification");
    let rawWrites = 0;
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => {
          rawWrites += 1;
          return { rows: [] };
        },
      });
    try {
      await expect(svc.executeSleep(AGENT, ORG)).resolves.toEqual({
        success: false,
        containerRemoved: false,
        error: "Agent lifecycle changed while sleep was prepared",
      });
      expect(capture).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();
      expect(stamp).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(rawWrites).toBe(0);
    } finally {
      upgradeTransactionImpl = null;
      primary.mockRestore();
      lock.mockRestore();
      lockedRead.mockRestore();
      capture.mockRestore();
      createBackup.mockRestore();
      stamp.mockRestore();
    }
  });

  test("sleep on an unreachable old node retains compute locators for retry", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = { ...claimedPendingRow(), status: "stopped" as const };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {
        throw new Error("old node unreachable");
      }),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue({
      id: "durable-backup",
    } as never);
    // Fresh verified stamp: the sleep fallback gate accepts this row without
    // a live decrypt, keeping these tests focused on the later stages.
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "durable-backup",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        verification_status: "verified",
        verified_at: new Date(),
        created_at: new Date(),
      } as never,
    );
    const tx = armSleepTransaction(svc, rec);
    try {
      const result = await svc.executeSleep(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerRemoved: false,
        error: "old node unreachable",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(tx.writes).toHaveLength(0);
    } finally {
      upgradeTransactionImpl = null;
      find.mockRestore();
      backup.mockRestore();
      storedBackup.mockRestore();
      tx.lockLifecycle.mockRestore();
      tx.getForMutation.mockRestore();
      tx.activeReplacement.mockRestore();
    }
  });

  test("sleep rejects a newer lifecycle generation without stopping or clearing it", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = { ...claimedPendingRow(), status: "stopped" as const };
    const replacement: AgentSandbox = {
      ...rec,
      sandbox_id: "replacement-container",
      node_id: "replacement-node",
      container_name: "replacement-container",
      updated_at: new Date(rec.updated_at.getTime() + 1_000),
    };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue({
      id: "durable-backup",
    } as never);
    // Fresh verified stamp: the sleep fallback gate accepts this row without
    // a live decrypt, keeping these tests focused on the later stages.
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "durable-backup",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        verification_status: "verified",
        verified_at: new Date(),
        created_at: new Date(),
      } as never,
    );
    const tx = armSleepTransaction(svc, replacement);

    try {
      const result = await svc.executeSleep(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerRemoved: false,
        error: "Agent lifecycle changed while sleep was prepared",
      });
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(tx.writes).toHaveLength(0);
    } finally {
      upgradeTransactionImpl = null;
      find.mockRestore();
      backup.mockRestore();
      storedBackup.mockRestore();
      tx.lockLifecycle.mockRestore();
      tx.getForMutation.mockRestore();
      tx.activeReplacement.mockRestore();
    }
  });

  test("sleep holds the lifecycle generation through strict stop and exact locator clear", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const rec = { ...claimedPendingRow(), status: "stopped" as const };
    const provider: SandboxProvider = {
      create: mock(async () => {
        throw new Error("must not create");
      }),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as SleepSvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(rec);
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue({
      id: "durable-backup",
    } as never);
    // Fresh verified stamp: the sleep fallback gate accepts this row without
    // a live decrypt, keeping these tests focused on the later stages.
    const storedBackup = spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(
      {
        id: "durable-backup",
        sandbox_record_id: rec.id,
        snapshot_type: "pre-shutdown",
        verification_status: "verified",
        verified_at: new Date(),
        created_at: new Date(),
      } as never,
    );
    const prune = spyOn(agentSandboxesRepository, "pruneBackups").mockResolvedValue(undefined);
    const tx = armSleepTransaction(svc, rec);

    try {
      const result = await svc.executeSleep(AGENT, ORG);
      expect(result).toEqual({
        success: true,
        containerRemoved: true,
        backupId: "durable-backup",
      });
      expect(provider.stopForReplacement).toHaveBeenCalledTimes(1);
      expect(provider.stopForReplacement).toHaveBeenCalledWith(rec.sandbox_id);
      expect(tx.writes).toHaveLength(1);
      expect(prune).toHaveBeenCalledWith(rec.id, expect.any(Number));
    } finally {
      upgradeTransactionImpl = null;
      find.mockRestore();
      backup.mockRestore();
      storedBackup.mockRestore();
      prune.mockRestore();
      tx.lockLifecycle.mockRestore();
      tx.getForMutation.mockRestore();
      tx.activeReplacement.mockRestore();
    }
  });
});

// Orphaned shared-runtime history on delete is covered at the repository level
// in shared-runtime-history.test.ts: the post-commit deletion is a best-effort
// call to sharedRuntimeHistoryRepository.deleteByAgent.

// Fail-closed pre-deletion capture (#18517): deleteAgent mirrors shutdown's
// pre-stop discipline — a live dedicated agent is never deleted without a
// current backup, and a refusal happens BEFORE deletion intent is stamped so
// the reconciler cannot re-arm a delete that skipped the capture.
describe("ElizaSandboxService.deleteAgent fail-closed pre-deletion capture (#18517)", () => {
  type CaptureSpyTarget = {
    getAgentForWrite: (agentId: string, orgId: string) => Promise<unknown>;
    fetchSnapshotState: (rec: unknown) => Promise<unknown>;
    prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
    persistSnapshotWithinTransaction: (
      ...args: unknown[]
    ) => Promise<{ backupId: string; lifecycleRevision: number }>;
    lockLifecycle: (...args: unknown[]) => Promise<void>;
    getAgentForLifecycleMutation: (...args: unknown[]) => Promise<unknown>;
    hasActiveProvisionJobTx: (...args: unknown[]) => Promise<boolean>;
    hasActiveReplacementJobTx: (...args: unknown[]) => Promise<boolean>;
  };

  async function makeCaptureSvc() {
    const mod = await import("./eliza-sandbox.ts?actual");
    const svc = new mod.ElizaSandboxService();
    return { mod, svc, spyTarget: svc as unknown as CaptureSpyTarget };
  }

  test("a failing pre-deletion capture refuses the delete before deletion intent", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error("bridge returned 500"),
    );
    const prepare = spyOn(spyTarget, "prepareAgentDelete");
    try {
      const result = await svc.deleteAgent(rec.id, rec.organization_id, {
        authorization: "user_request",
      });
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toContain(
        "Refusing to delete without a current backup",
      );
      expect(result.success === false && result.error).toContain("bridge returned 500");
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("an explicit state-loss acknowledgement binds a capture waiver to this generation", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error("available-memory budget exceeded"),
    );
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, {
          authorization: "user_request",
          stateLossAcknowledged: true,
        }),
      ).resolves.toEqual({ success: false, error: "halted by test after capture phase" });
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: rec,
        captureWaiverGeneration: {
          bridgeUrl: rec.bridge_url,
          environmentRevision: rec.environment_revision,
          sandboxId: rec.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a transient capture failure refuses the delete with the transient message", async () => {
    const { mod, svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error(mod.SNAPSHOT_CAPTURE_TRANSIENT),
    );
    const prepare = spyOn(spyTarget, "prepareAgentDelete");
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" }),
      ).resolves.toEqual({
        success: false,
        retryable: true,
        error: `Refusing to delete without a current backup: ${mod.SNAPSHOT_CAPTURE_TRANSIENT}`,
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("an image without a snapshot endpoint proceeds, flagged as capture-unsupported", async () => {
    const { mod, svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error(mod.SNAPSHOT_ENDPOINT_UNSUPPORTED),
    );
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" }),
      ).resolves.toEqual({ success: false, error: "halted by test after capture phase" });
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: rec,
        captureWaiverGeneration: {
          bridgeUrl: rec.bridge_url,
          environmentRevision: rec.environment_revision,
          sandboxId: rec.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a persisted no-snapshot waiver lets the same deletion retry converge", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
      pre_delete_capture_waiver_attempt_id: deletionAttemptId,
      pre_delete_capture_waiver_environment_revision: 0,
      pre_delete_capture_waiver_sandbox_id: "sandbox-e06bb509",
      pre_delete_capture_waiver_bridge_url: "https://legacy-bridge.example",
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      undefined,
    );
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: true,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a no-snapshot waiver does not survive a bridge generation change", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const live = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      bridge_url: "https://replacement-bridge.example",
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
      pre_delete_capture_waiver_attempt_id: deletionAttemptId,
      pre_delete_capture_waiver_environment_revision: 0,
      pre_delete_capture_waiver_sandbox_id: "sandbox-e06bb509",
      pre_delete_capture_waiver_bridge_url: "https://legacy-bridge.example",
    };
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const update = mock(() => ({
      set: mock(() => ({ where: mock(() => ({ returning: mock(async () => []) })) })),
    }));
    upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }), update });
    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
          snapshot: null,
          captureAuthority: null,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: true,
          existingBackup: null,
        }),
      ).resolves.toEqual({
        ok: false,
        error:
          "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
      });
      expect(update).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("a data-bearing error row with no reachable bridge fails closed", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = { ...customSandbox(), status: "error" as const, bridge_url: null };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(spyTarget, "prepareAgentDelete");
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" }),
      ).resolves.toEqual({
        success: false,
        error:
          "Refusing to delete without a current backup: the agent's container has no reachable bridge to capture from",
      });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a stopped-origin deletion continuation does not recapture a dead container", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      bridge_url: null,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
      deletion_allocation_counted: false,
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("shared-tier rows skip the capture entirely", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = { ...customSandbox(), execution_tier: "shared" as const };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("the primary v1 path (row already deletion_pending at enqueue) still captures", async () => {
    // The v1 DELETE route stamps `deletion_pending` at enqueue time and only
    // later runs deleteAgent from the job worker — the container is still
    // live, so the capture must fire there too, not only on the synchronous
    // compat path that still sees `running`.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      undefined,
    );
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockRejectedValue(
      new Error("bridge unreachable"),
    );
    const prepare = spyOn(spyTarget, "prepareAgentDelete");
    try {
      const result = await svc.deleteAgent(rec.id, rec.organization_id, {
        authorization: "user_request",
      });
      expect(fetchSnap).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.success === false && result.error).toContain(
        "Refusing to delete without a current backup",
      );
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("a deletion retry with a capture already persisted for this intent skips re-capturing", async () => {
    // After a successful capture the teardown may still fail; the retry then
    // faces a dead bridge and must not refuse forever — the pre-delete backup
    // taken at or after this deletion's start already satisfies the guarantee.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue({
      id: priorBackupId,
      created_at: new Date("2026-08-13T00:05:00.000Z"),
    } as never);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id, { authorization: "user_request" });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: {
          id: priorBackupId,
          deletionAttemptId: rec.deletion_attempt_id,
        },
      });
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("an unauthorized delete of a running agent never pays the capture round-trip", async () => {
    // The pre-existing running-row gate refuses unauthorized deletes anyway,
    // so a capture (or a capture OUTAGE) must not run first — the caller keeps
    // the original "suspend it before deletion" refusal, covered by the
    // teardown-cap tests above.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "Agent is running; suspend it before deletion",
    });
    try {
      await expect(svc.deleteAgent(rec.id, rec.organization_id)).resolves.toEqual({
        success: false,
        error: "Agent is running; suspend it before deletion",
      });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("account deletion does not create a new backup of data being erased", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = customSandbox();
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState");
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await expect(
        svc.deleteAgent(rec.id, rec.organization_id, {
          authorization: "account_deletion",
        }),
      ).resolves.toEqual({ success: false, error: "halted by test after capture phase" });
      expect(fetchSnap).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, "account_deletion", {
        snapshot: null,
        captureAuthority: null,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("the reconciler's unauthorized re-enqueue of a deletion_pending row still captures", async () => {
    // ProvisioningJobService.reEnqueueFailedDeletions re-arms stuck deletes with
    // NO authorization (the original job's grant is not carried through). Gating
    // phase 0 on `options.authorization` sent those jobs into prepareAgentDelete
    // with `snapshot: null` against a capture-requiring row, so every attempt was
    // refused as "lifecycle generation moved" — deadlocking exactly the stuck
    // deletions this guard protects. Only the still-`running` unauthorized case
    // may skip the capture.
    const { svc, spyTarget } = await makeCaptureSvc();
    const rec = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const getForWrite = spyOn(spyTarget, "getAgentForWrite").mockResolvedValue(rec);
    const priorBackup = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      undefined,
    );
    const snapshot = {
      stateData: { tables: { memories: 1 } },
      sizeBytes: 21,
      bridgeUrl: rec.bridge_url as string,
    };
    const fetchSnap = spyOn(spyTarget, "fetchSnapshotState").mockResolvedValue(snapshot);
    const prepare = spyOn(spyTarget, "prepareAgentDelete").mockResolvedValue({
      ok: false,
      error: "halted by test after capture phase",
    });
    try {
      await svc.deleteAgent(rec.id, rec.organization_id);
      expect(fetchSnap).toHaveBeenCalledTimes(1);
      expect(prepare).toHaveBeenCalledWith(rec.id, rec.organization_id, undefined, {
        snapshot,
        captureAuthority: rec,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      });
    } finally {
      getForWrite.mockRestore();
      priorBackup.mockRestore();
      fetchSnap.mockRestore();
      prepare.mockRestore();
    }
  });

  test("prepareAgentDelete refuses when the lifecycle generation moved after the capture", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const live = customSandbox();
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const update = mock(() => ({
      set: mock(() => ({ where: mock(() => ({ returning: mock(async () => []) })) })),
    }));
    upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }), update });
    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
          snapshot: {
            stateData: { tables: {} },
            sizeBytes: 12,
            bridgeUrl: "https://a-different-generation.example",
          },
          captureAuthority: live,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: false,
          existingBackup: null,
        }),
      ).resolves.toEqual({
        ok: false,
        error:
          "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test.each([
    ["status", "disconnected"],
    ["node_id", "replacement-node"],
    ["container_name", "replacement-container"],
    ["health_url", "https://replacement.example/api"],
  ] as const)(
    "prepareAgentDelete refuses when captured %s changes under the lifecycle lock",
    async (field, replacement) => {
      const { svc, spyTarget } = await makeCaptureSvc();
      const captured = customSandbox();
      const locked = { ...captured, [field]: replacement };
      const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
      const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(
        locked,
      );
      const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
      const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
        false,
      );
      const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
      const update = mock(() => ({
        set: mock(() => ({ where: mock(() => ({ returning: mock(async () => []) })) })),
      }));
      upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }), update });
      try {
        await expect(
          (
            svc as unknown as {
              prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
            }
          ).prepareAgentDelete(captured.id, captured.organization_id, "user_request", {
            snapshot: {
              stateData: { tables: {} },
              sizeBytes: 12,
              bridgeUrl: captured.bridge_url,
            },
            captureAuthority: captured,
            captureWaiverGeneration: null,
            captureWaiverAlreadyPersisted: false,
            existingBackup: null,
          }),
        ).resolves.toEqual({
          ok: false,
          error:
            "Refusing to delete: the agent's lifecycle generation moved after the pre-deletion capture; retry the delete.",
        });
        expect(persist).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      } finally {
        upgradeTransactionImpl = null;
        lockLifecycle.mockRestore();
        getForMutation.mockRestore();
        activeProvision.mockRestore();
        activeReplacement.mockRestore();
        persist.mockRestore();
      }
    },
  );

  test("prepareAgentDelete persists the pre-delete snapshot inside the deletion transaction", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const live = customSandbox();
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persistedBackupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const order: string[] = [];
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction").mockImplementation(
      async () => {
        order.push("backup");
        return { backupId: persistedBackupId, lifecycleRevision: 8 };
      },
    );
    const stateData = { tables: { memories: 3 } };
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => {
            order.push("intent");
            return [
              {
                id: live.id,
                deletionAttemptId: "attempt-18517",
                deletionStartedAt: new Date(),
                lifecycleRevision: 7,
              },
            ];
          }),
        })),
      })),
    }));
    upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }), update });
    try {
      const result = (await (
        svc as unknown as {
          prepareAgentDelete: (...args: unknown[]) => Promise<{ ok: boolean }>;
        }
      ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
        snapshot: { stateData, sizeBytes: 34, bridgeUrl: live.bridge_url as string },
        captureAuthority: live,
        captureWaiverGeneration: null,
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        preDeleteBackupId: persistedBackupId,
        lifecycleRevision: 8,
      });
      expect(order).toEqual(["intent", "backup"]);
      expect(persist).toHaveBeenCalledTimes(1);
      const call = persist.mock.calls[0] as unknown[];
      expect(call.slice(1)).toEqual([live.id, live.organization_id, "pre-delete", stateData, 34]);
    } finally {
      upgradeTransactionImpl = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("prepareAgentDelete persists an unsupported-endpoint waiver for the exact generation", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const live = customSandbox();
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const set = mock((values: Record<string, unknown>) => ({
      where: mock(() => ({
        returning: mock(async () => [
          {
            id: live.id,
            deletionAttemptId: values.deletion_attempt_id,
            deletionStartedAt: new Date(),
            lifecycleRevision: 7,
          },
        ]),
      })),
    }));
    const update = mock(() => ({ set }));
    upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }), update });
    try {
      const result = (await (
        svc as unknown as {
          prepareAgentDelete: (...args: unknown[]) => Promise<{ ok: boolean }>;
        }
      ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
        snapshot: null,
        captureAuthority: live,
        captureWaiverGeneration: {
          bridgeUrl: live.bridge_url,
          environmentRevision: live.environment_revision,
          sandboxId: live.sandbox_id,
        },
        captureWaiverAlreadyPersisted: false,
        existingBackup: null,
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(persist).not.toHaveBeenCalled();
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          pre_delete_capture_waiver_attempt_id: expect.any(String),
          pre_delete_capture_waiver_environment_revision: live.environment_revision,
          pre_delete_capture_waiver_sandbox_id: live.sandbox_id,
          pre_delete_capture_waiver_bridge_url: live.bridge_url,
        }),
      );
    } finally {
      upgradeTransactionImpl = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("prepareAgentDelete revalidates an unlocked backup candidate under the lifecycle lock", async () => {
    const { svc, spyTarget } = await makeCaptureSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const backupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const live = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: deletionAttemptId,
      deletion_started_at: new Date("2026-08-13T00:00:00.000Z"),
    };
    const lockLifecycle = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(spyTarget, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(spyTarget, "hasActiveReplacementJobTx").mockResolvedValue(
      false,
    );
    const validate = spyOn(
      agentSandboxesRepository,
      "validateAttachedPreDeleteBackupForDeletion",
    ).mockResolvedValue(true);
    const persist = spyOn(spyTarget, "persistSnapshotWithinTransaction");
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => [
            {
              id: live.id,
              deletionAttemptId,
              deletionStartedAt: live.deletion_started_at,
              lifecycleRevision: 7,
            },
          ]),
        })),
      })),
    }));
    upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }), update });
    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(live.id, live.organization_id, "user_request", {
          snapshot: null,
          captureAuthority: null,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: false,
          existingBackup: { id: backupId, deletionAttemptId },
        }),
      ).resolves.toMatchObject({ ok: true, preDeleteBackupId: backupId });
      expect(validate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          backupId,
          sandboxRecordId: live.id,
          deletionStartedAt: live.deletion_started_at,
        }),
      );
      expect(persist).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      validate.mockRestore();
      persist.mockRestore();
    }
  });
});

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
    executeDeletion(
      agentId: string,
      orgId: string,
      authorization?: "user_request" | "billing_request",
    ): Promise<{
      success: boolean;
      containerStopped: boolean;
      rowDeleted: boolean;
      error?: string;
    }>;
    prepareAgentDelete(
      agentId: string,
      orgId: string,
      authorization?: "user_request" | "billing_request",
    ): Promise<
      | {
          ok: true;
          sandboxId: string | null;
          status: string;
          sourcePoolId: string | null;
        }
      | { ok: false; error: string }
    >;
    commitAgentRowDelete(agentId: string, orgId: string, ownership?: unknown): Promise<unknown>;
    commitAgentReconciliationPending(agentId: string, orgId: string): Promise<unknown>;
    runBoundedSandboxStop(sandboxId: string): Promise<unknown>;
    retirePersistedReplacementCleanup(agentId: string, orgId: string): Promise<string>;
  };

  async function makeSvc(cleanupSource?: AgentSandbox): Promise<Svc> {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService();
    // Phase 0 of deleteAgent (#18517) consults the live row before stamping
    // deletion intent; these tests exercise the later teardown phases, so the
    // capture sees no row and skips. Instance-scoped, so no cross-test leak.
    spyOn(
      svc as unknown as { getAgentForWrite: () => Promise<AgentSandbox | undefined> },
      "getAgentForWrite",
    ).mockResolvedValue(cleanupSource);
    return svc as unknown as Svc;
  }

  test("executeDeletion retries without deleting while exact replacement cleanup is unresolved", async () => {
    const cleanupSource = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      replacement_cleanup_sandbox_id: "replacement-sandbox",
      replacement_cleanup_node_id: "replacement-node",
      replacement_cleanup_container_name: "replacement-container",
      replacement_cleanup_attempt_id: "88888888-8888-4888-8888-888888888888",
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-29T14:00:00.000Z"),
    };
    const svc = await makeSvc(cleanupSource);
    const retire = spyOn(svc, "retirePersistedReplacementCleanup").mockRejectedValue(
      new Error("exact Docker absence is not proven"),
    );
    const deleteAgent = spyOn(svc, "deleteAgent");

    await expect(svc.executeDeletion(AGENT, ORG, "user_request")).resolves.toEqual({
      success: false,
      containerStopped: false,
      rowDeleted: false,
      retryable: true,
      error: "Replacement cleanup is still pending: exact Docker absence is not proven",
    });
    expect(retire).toHaveBeenCalledWith(AGENT, ORG);
    expect(deleteAgent).not.toHaveBeenCalled();
  });

  test("executeDeletion removes the serving generation only after replacement cleanup converges", async () => {
    const cleanupSource = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      character_id: null,
      replacement_cleanup_sandbox_id: "replacement-sandbox",
      replacement_cleanup_node_id: "replacement-node",
      replacement_cleanup_container_name: "replacement-container",
      replacement_cleanup_attempt_id: "88888888-8888-4888-8888-888888888888",
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-29T14:00:00.000Z"),
    };
    const svc = await makeSvc(cleanupSource);
    const retire = spyOn(svc, "retirePersistedReplacementCleanup").mockResolvedValue("retired");
    const deleteAgent = spyOn(svc, "deleteAgent").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox: cleanupSource,
    });

    await expect(svc.executeDeletion(AGENT, ORG, "user_request")).resolves.toEqual({
      success: true,
      containerStopped: true,
      rowDeleted: true,
    });
    expect(retire).toHaveBeenCalledWith(AGENT, ORG);
    expect(deleteAgent).toHaveBeenCalledWith(AGENT, ORG, {
      authorization: "user_request",
      stateLossAcknowledged: undefined,
    });
    expect(retire.mock.invocationCallOrder[0]).toBeLessThan(
      deleteAgent.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test("prepareAgentDelete refuses an unauthorized running agent before deletion intent", async () => {
    const svc = await makeSvc();
    const live = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      last_heartbeat_at: new Date(Date.now() - 30_000),
    };
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(svc, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(svc, "hasActiveReplacementJobTx").mockResolvedValue(false);
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => [{ ...live, status: "deletion_pending" }]),
        })),
      })),
    }));
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => ({ rows: [] }),
        update,
      });

    try {
      await expect(svc.prepareAgentDelete(AGENT, ORG)).resolves.toEqual({
        ok: false,
        error: "Agent is running; suspend it before deletion",
      });
      expect(update).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
    }
  });

  test("prepareAgentDelete allows an explicitly authorized running agent", async () => {
    const svc = await makeSvc();
    const live = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      last_heartbeat_at: null,
    };
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(live);
    const activeProvision = spyOn(svc, "hasActiveProvisionJobTx").mockResolvedValue(false);
    const activeReplacement = spyOn(svc, "hasActiveReplacementJobTx").mockResolvedValue(false);
    // An authorized live-row delete must carry a current-generation capture
    // (#18517); persistence itself is covered by the dedicated capture tests.
    const persist = spyOn(
      svc as unknown as {
        persistSnapshotWithinTransaction: (
          ...args: unknown[]
        ) => Promise<{ backupId: string; lifecycleRevision: number }>;
      },
      "persistSnapshotWithinTransaction",
    ).mockResolvedValue({
      backupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      lifecycleRevision: 2,
    });
    const update = mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => [
            {
              id: AGENT,
              deletionAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              deletionStartedAt: new Date("2026-06-04T12:00:00.000Z"),
              lifecycleRevision: 1,
            },
          ]),
        })),
      })),
    }));
    upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }), update });

    try {
      await expect(
        (
          svc as unknown as {
            prepareAgentDelete: (...args: unknown[]) => Promise<unknown>;
          }
        ).prepareAgentDelete(AGENT, ORG, "user_request", {
          snapshot: {
            stateData: { tables: {} },
            sizeBytes: 1,
            bridgeUrl: live.bridge_url,
          },
          captureAuthority: live,
          captureWaiverGeneration: null,
          captureWaiverAlreadyPersisted: false,
          existingBackup: null,
        }),
      ).resolves.toMatchObject({
        ok: true,
      });
      expect(update).toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      activeProvision.mockRestore();
      activeReplacement.mockRestore();
      persist.mockRestore();
    }
  });

  test("linked character cleanup waits until the reconciliation tombstone is removed", async () => {
    const svc = await makeSvc();
    const characterId = "44444444-4444-4444-8444-444444444444";
    const deletedSandbox = {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      character_id: characterId,
      agent_config: {},
    };
    const deletion = spyOn(svc, "deleteAgent")
      .mockResolvedValueOnce({
        success: true,
        rowDeleted: false,
        reconciliationPending: true,
        deletedSandbox,
      })
      .mockResolvedValueOnce({
        success: true,
        rowDeleted: true,
        deletedSandbox,
      });
    const deleteCharacter = spyOn(userCharactersRepository, "delete").mockResolvedValue(undefined);

    try {
      await expect(svc.executeDeletion(AGENT, ORG)).resolves.toEqual({
        success: true,
        containerStopped: false,
        rowDeleted: false,
      });
      expect(deleteCharacter).not.toHaveBeenCalled();

      await expect(svc.executeDeletion(AGENT, ORG)).resolves.toEqual({
        success: true,
        containerStopped: true,
        rowDeleted: true,
      });
      expect(deleteCharacter).toHaveBeenCalledTimes(1);
      expect(deleteCharacter).toHaveBeenCalledWith(characterId);
    } finally {
      deletion.mockRestore();
      deleteCharacter.mockRestore();
    }
  });

  test("(a) teardown timeout completes the attempt but retains a reconciliation tombstone", async () => {
    const svc = await makeSvc();
    const deletedSandbox = { ...customSandbox(), id: AGENT, organization_id: ORG };
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    // Timed-out teardown is reported as an explicit tagged outcome.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-timed-out",
      error: new Error("agent-delete stop sandbox-e06bb509 timed out after 120000ms"),
    });
    const commit = spyOn(svc, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox,
    });
    const retain = spyOn(svc, "commitAgentReconciliationPending").mockResolvedValue({
      success: true,
      rowDeleted: false,
      reconciliationPending: true,
      deletedSandbox,
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as {
        success: boolean;
        rowDeleted?: boolean;
        deletedSandbox?: unknown;
      };
      // A hang does not retry in the hot queue, but its ownership row remains.
      expect(res.success).toBe(true);
      expect(res.rowDeleted).toBe(false);
      expect(res.deletedSandbox).toEqual(deletedSandbox);
      expect(commit).not.toHaveBeenCalled();
      expect(retain).toHaveBeenCalledTimes(1);
      // The warning must flag abandonment while preserving capacity accounting.
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("timed out");
      expect(warned).toContain("ABANDONING");
      expect(warned).toContain("retaining its capacity");
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      retain.mockRestore();
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
      sourcePoolId: null,
    });
    // Bounded (non-timeout) failure with a non-ignorable message.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
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
      sourcePoolId: null,
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error("container not found"),
    });
    const commit = spyOn(svc, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
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

  test("(d) a missing-node-metadata hydration failure (node purged from docker_nodes) → ignorable, delete proceeds", async () => {
    const svc = await makeSvc();
    const deletedSandbox = { ...customSandbox(), id: AGENT, organization_id: ORG };
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    // The exact shape hydrateContainerFromDb throws when the sandbox row
    // points at a node that no longer has a docker_nodes record: the host is
    // gone, so there is nothing left to stop.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error(
        '[docker-sandbox] Missing persisted docker node metadata for node "node-decommissioned"',
      ),
    });
    const commit = spyOn(svc, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
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

  test("(e) an unrelated hydration failure (missing port data) → still NOT ignorable, delete aborts", async () => {
    const svc = await makeSvc();
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "running",
      sourcePoolId: null,
    });
    // A sibling hydrateContainerFromDb failure that does NOT mean the host is
    // gone — the container may still be running, so the delete must escalate.
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "stop-failed",
      error: new Error(
        '[docker-sandbox] Missing port data for "sandbox-e06bb509": bridge=null, webUi=null',
      ),
    });
    const commit = spyOn(svc, "commitAgentRowDelete");
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const res = (await svc.deleteAgent(AGENT, ORG)) as { success: boolean; error?: string };
      expect(res.success).toBe(false);
      expect(res.error).toBe("Failed to delete sandbox");
      expect(commit).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("the bounded teardown runs OUTSIDE the row-delete phase (sequenced, not nested)", async () => {
    const svc = await makeSvc();
    const order: string[] = [];
    const sourcePoolId = "44444444-4444-4444-8444-444444444444";
    const preDeleteBackupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const prepare = spyOn(svc, "prepareAgentDelete").mockImplementation(async () => {
      order.push("prepare");
      return {
        ok: true,
        sandboxId: SANDBOX_ID,
        nodeId: null,
        status: "running",
        sourcePoolId,
        environmentRevision: 4,
        lifecycleRevision: 9,
        deletionAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        preDeleteBackupId,
      };
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockImplementation(async () => {
      order.push("teardown");
      return { kind: "not-running-proven" };
    });
    const commit = spyOn(svc, "commitAgentRowDelete").mockImplementation(async () => {
      order.push("commit");
      return {
        success: true,
        rowDeleted: true,
        deletedSandbox: { ...customSandbox(), id: AGENT },
      };
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockImplementation(
      async (credentialOwnerId) => {
        order.push(`revoke:${credentialOwnerId}`);
      },
    );
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    try {
      await svc.deleteAgent(AGENT, ORG);
      // Teardown must happen between the precheck txn and the row-delete txn,
      // never inside the write-lock/transaction.
      expect(order).toEqual([
        "prepare",
        "teardown",
        `revoke:${AGENT}`,
        `revoke:${sourcePoolId}`,
        "commit",
      ]);
      expect(commit).toHaveBeenCalledWith(
        AGENT,
        ORG,
        expect.objectContaining({ preDeleteBackupId }),
      );
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  test("allocation release carries its post-trigger revision into the delete CAS", async () => {
    const svc = await makeSvc();
    const deletionAttemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      nodeId: "node-1",
      status: "running",
      sourcePoolId: null,
      environmentRevision: 4,
      lifecycleRevision: 9,
      deletionAttemptId,
      deletionStartedAt: new Date("2026-08-13T12:00:00.000Z"),
      preDeleteBackupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "not-running-proven",
    });
    const release = spyOn(
      agentSandboxesRepository,
      "tryReleaseDeletionAllocationForCommit",
    ).mockResolvedValue({ outcome: "released", lifecycleRevision: 10 });
    const commit = spyOn(svc, "commitAgentRowDelete").mockResolvedValue({
      success: true,
      rowDeleted: true,
      deletedSandbox: { ...customSandbox(), id: AGENT },
    });
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined as never);
    const historySpy = spyOn(sharedRuntimeHistoryRepository, "deleteByAgent").mockResolvedValue(0);
    try {
      await expect(svc.deleteAgent(AGENT, ORG)).resolves.toMatchObject({
        success: true,
        rowDeleted: true,
      });
      expect(release).toHaveBeenCalledWith(AGENT, ORG, deletionAttemptId, "node-1", 9);
      expect(commit).toHaveBeenCalledWith(
        AGENT,
        ORG,
        expect.objectContaining({ lifecycleRevision: 10, deletionAttemptId }),
      );
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      release.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
      historySpy.mockRestore();
    }
  });

  test("an authoritative credential revoke failure preserves the row for retry", async () => {
    const svc = await makeSvc();
    const sourcePoolId = "44444444-4444-4444-8444-444444444444";
    const prepare = spyOn(svc, "prepareAgentDelete").mockResolvedValue({
      ok: true,
      sandboxId: SANDBOX_ID,
      status: "error",
      sourcePoolId,
    });
    const stop = spyOn(svc, "runBoundedSandboxStop").mockResolvedValue({
      kind: "not-running-proven",
    });
    const commit = spyOn(svc, "commitAgentRowDelete");
    const apiKeySpy = spyOn(apiKeysService, "revokeForAgent")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("authoritative revoke unavailable"));
    try {
      await expect(svc.deleteAgent(AGENT, ORG)).rejects.toThrow("authoritative revoke unavailable");
      expect(apiKeySpy.mock.calls.map(([owner]) => owner)).toEqual([AGENT, sourcePoolId]);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      stop.mockRestore();
      commit.mockRestore();
      apiKeySpy.mockRestore();
    }
  });

  test("runBoundedSandboxStop returns proven absence from a clean provider stop", async () => {
    const svc = await makeSvc();
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      stopForDeletion: async () => ({ kind: "not-running-proven" as const }),
    } as unknown as SandboxProvider);
    try {
      const res = await svc.runBoundedSandboxStop(SANDBOX_ID);
      expect(res).toEqual({ kind: "not-running-proven" });
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
      stopForDeletion: async () => {
        throw boom;
      },
    } as unknown as SandboxProvider);
    try {
      const res = (await svc.runBoundedSandboxStop(SANDBOX_ID)) as {
        kind: string;
        error: unknown;
      };
      expect(res.kind).toBe("stop-failed");
      expect(res.error).toBe(boom);
    } finally {
      getProvider.mockRestore();
    }
  });

  // The whole reason #9066 exists: a provider stop that genuinely never
  // settles (SSH connect / provider init wedge) must be cut off at the hard
  // cap so a single stuck node can't hang the delete past the job watchdog and
  // wedge the provisioning worker. The two tests above cover clean/error; this
  // one drives the REAL withTimeout branch — a never-settling stop raced under
  // fake timers — and asserts the tagged timeout used to preserve capacity.
  test("runBoundedSandboxStop cuts off a never-settling provider stop", async () => {
    const svc = await makeSvc();
    // Never resolves and never rejects: the only way out is the timeout race.
    const getProvider = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      stopForDeletion: () => new Promise<never>(() => {}),
    } as unknown as SandboxProvider);
    jest.useFakeTimers();
    try {
      const pending = svc.runBoundedSandboxStop(SANDBOX_ID) as Promise<{
        kind: string;
        error: unknown;
      }>;
      // Let getProvider() + the try-body microtasks settle so the timeout
      // timer is actually armed, then blow past the 120s hard cap.
      await Promise.resolve();
      jest.advanceTimersByTime(120_001);
      const res = await pending;
      expect(res.kind).toBe("stop-timed-out");
      expect(res.error).toBeInstanceOf(Error);
      expect((res.error as Error).message).toContain("timed out after");
    } finally {
      jest.useRealTimers();
      getProvider.mockRestore();
    }
  });
});

describe("failed warm-claim replacement teardown", () => {
  type RetrySvc = {
    provision(agentId: string, orgId: string): Promise<unknown>;
    retireFailedWarmClaimForRetry(
      agentId: string,
      orgId: string,
    ): Promise<{ success: true } | { success: false; error: string }>;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
    ensureRuntimeAgentStarted(): Promise<unknown>;
  };

  function failedWarmClaim(): AgentSandbox {
    return {
      ...customSandbox(),
      status: "error",
      claimed_at: new Date("2026-07-23T00:00:00.000Z"),
      warm_claim_credential_state: "failed",
      warm_claim_cleanup_completed_at: new Date("2026-07-23T00:05:00.000Z"),
      sandbox_id: "old-warm-container",
      node_id: "unreachable-node",
      container_name: "old-warm-container",
    };
  }

  test("an unreachable old container preserves the fence and never creates a replacement", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const create = mock(async () => {
      throw new Error("replacement must not be created");
    });
    const stop = mock(async () => {});
    const stopForReplacement = mock(async () => {
      throw new Error("node unreachable; absence unresolved");
    });
    const provider: SandboxProvider = {
      create,
      stop,
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(failed);
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(failed);
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = (await svc.provision(failed.id, failed.organization_id)) as {
        success: boolean;
        error?: string;
      };
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: "Failed to retire the previous warm-claim container",
        }),
      );
      expect(stopForReplacement).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
    }
  });

  test("a partial old locator fails closed before teardown or reset", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const create = mock(async () => {
      throw new Error("replacement must not be created");
    });
    const stopForReplacement = mock(async () => {});
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(failed);
    const partial = { ...failed, sandbox_id: null };
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(partial);
    const writes: unknown[] = [];
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async (query) => {
          writes.push(query);
          return { rows: [] };
        },
      });

    try {
      const result = (await svc.provision(failed.id, failed.organization_id)) as {
        success: boolean;
        error?: string;
      };
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: "Previous warm-claim container locator is incomplete",
        }),
      );
      expect(stopForReplacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(create).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
    }
  });

  test("a proven stop resets the exact handle and creates one cold replacement", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const resetRow: AgentSandbox = {
      ...failed,
      status: "stopped",
      claimed_at: null,
      warm_claim_credential_state: null,
      warm_claim_source_pool_id: null,
      warm_claim_key_fingerprint: null,
      warm_claim_attested_at: null,
      warm_claim_attested_environment_revision: null,
      warm_claim_cleanup_completed_at: null,
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      database_uri: "postgres://shared.example/railway",
      database_status: "ready",
      execution_tier: "custom",
    };
    const finalRow: AgentSandbox = {
      ...resetRow,
      status: "running",
      sandbox_id: "replacement-sandbox",
      node_id: "replacement-node",
      container_name: "replacement-container",
      bridge_url: "https://replacement.example",
      health_url: "https://replacement.example/api",
    };
    const order: string[] = [];
    const stopForReplacement = mock(async () => {
      order.push("strict-stop");
    });
    const create = mock(async () => {
      order.push("create");
      return {
        sandboxId: "replacement-sandbox",
        bridgeUrl: "https://replacement.example",
        healthUrl: "https://replacement.example/api",
        metadata: {
          provider: "docker",
          nodeId: "replacement-node",
          hostname: "replacement.internal",
          containerName: "replacement-container",
          bridgePort: 21070,
          webUiPort: 23900,
          agentId: failed.id,
          volumePath: "/var/lib/eliza/replacement",
          dockerImage: "ghcr.io/elizaos/eliza:sha-current",
          imageDigest: "sha256:replacement",
        },
      };
    });
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg")
      .mockResolvedValueOnce(failed)
      .mockResolvedValue(resetRow);
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(failed);
    upgradeTransactionImpl = async (fn) =>
      fn({
        execute: async () => {
          order.push("cas-reset");
          return { rows: [{ id: failed.id }] };
        },
      });
    const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...resetRow,
      status: "provisioning",
    });
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(undefined);
    const update = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...resetRow, ...data }),
    );
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const ensureStarted = spyOn(svc, "ensureRuntimeAgentStarted").mockResolvedValue(null);

    try {
      const result = (await svc.provision(failed.id, failed.organization_id)) as {
        success: boolean;
        sandboxRecord?: AgentSandbox;
      };
      expect(result.success).toBe(true);
      expect(result.sandboxRecord).toBe(finalRow);
      expect(order).toEqual(["strict-stop", "cas-reset", "create"]);
      expect(stopForReplacement).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      upgradeTransactionImpl = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      lock.mockRestore();
      backup.mockRestore();
      update.mockRestore();
      mint.mockRestore();
      ensureStarted.mockRestore();
    }
  });

  test("two failed-claim retries serialize teardown ownership and create one replacement", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const failed = failedWarmClaim();
    const resetRow: AgentSandbox = {
      ...failed,
      status: "stopped",
      claimed_at: null,
      warm_claim_credential_state: null,
      warm_claim_source_pool_id: null,
      warm_claim_key_fingerprint: null,
      warm_claim_attested_at: null,
      warm_claim_attested_environment_revision: null,
      warm_claim_cleanup_completed_at: null,
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      database_uri: "postgres://shared.example/railway",
      database_status: "ready",
      execution_tier: "custom",
    };
    const finalRow: AgentSandbox = {
      ...resetRow,
      status: "running",
      sandbox_id: "replacement-sandbox",
      node_id: "replacement-node",
      container_name: "replacement-container",
      bridge_url: "https://replacement.example",
      health_url: "https://replacement.example/api",
    };

    let releaseInitialReads!: () => void;
    const bothInitialReads = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let initialReadCount = 0;
    let lifecycleRow = failed;
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(async () => {
      if (initialReadCount < 2) {
        initialReadCount += 1;
        if (initialReadCount === 2) releaseInitialReads();
        await bothInitialReads;
        return failed;
      }
      return lifecycleRow;
    });

    let releaseStrictStop!: () => void;
    const strictStopMayFinish = new Promise<void>((resolve) => {
      releaseStrictStop = resolve;
    });
    let signalStrictStopStarted!: () => void;
    const strictStopStarted = new Promise<void>((resolve) => {
      signalStrictStopStarted = resolve;
    });
    const stopForReplacement = mock(async () => {
      signalStrictStopStarted();
      await strictStopMayFinish;
    });
    const create = mock(async () => ({
      sandboxId: "replacement-sandbox",
      bridgeUrl: "https://replacement.example",
      healthUrl: "https://replacement.example/api",
      metadata: {
        provider: "docker",
        nodeId: "replacement-node",
        hostname: "replacement.internal",
        containerName: "replacement-container",
        bridgePort: 21070,
        webUiPort: 23900,
        agentId: failed.id,
        volumePath: "/var/lib/eliza/replacement",
        dockerImage: "ghcr.io/elizaos/eliza:sha-current",
        imageDigest: "sha256:replacement",
      },
    }));
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const svc = new ElizaSandboxService(provider) as unknown as RetrySvc;
    const lockLifecycle = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const getForMutation = spyOn(svc, "getAgentForLifecycleMutation").mockImplementation(
      async () => lifecycleRow,
    );

    let transactionTail = Promise.resolve();
    upgradeTransactionImpl = async (fn) => {
      const previous = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previous;
      try {
        return await fn({
          execute: async () => {
            lifecycleRow = resetRow;
            return { rows: [{ id: failed.id }] };
          },
        });
      } finally {
        releaseTransaction();
      }
    };

    const setProvisioning = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
      { ...resetRow, status: "provisioning" },
    );
    const backup = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(undefined);
    const update = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "running" ? finalRow : { ...resetRow, ...data }),
    );
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const ensureStarted = spyOn(svc, "ensureRuntimeAgentStarted").mockResolvedValue(null);

    try {
      const first = svc.provision(failed.id, failed.organization_id);
      const second = svc.provision(failed.id, failed.organization_id);
      await strictStopStarted;
      await Promise.resolve();
      releaseStrictStop();
      const results = (await Promise.all([first, second])) as Array<{
        success: boolean;
        error?: string;
      }>;

      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(results.filter((result) => !result.success)).toEqual([
        expect.objectContaining({
          error: "Warm-claim retry ownership changed before teardown",
        }),
      ]);
      expect(stopForReplacement).toHaveBeenCalledTimes(1);
      expect(stopForReplacement).toHaveBeenCalledWith(failed.sandbox_id);
      expect(create).toHaveBeenCalledTimes(1);
      expect(setProvisioning).toHaveBeenCalledTimes(1);
    } finally {
      upgradeTransactionImpl = null;
      find.mockRestore();
      lockLifecycle.mockRestore();
      getForMutation.mockRestore();
      setProvisioning.mockRestore();
      backup.mockRestore();
      update.mockRestore();
      mint.mockRestore();
      ensureStarted.mockRestore();
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

  test("boots a freshly created agent on the seeded default character", async () => {
    const { buildAgentSandboxInsertValues } = await import("./eliza-sandbox.ts?actual");
    const { buildDefaultAgentCharacterConfig } = await import("./default-agent-character");
    const seed = buildDefaultAgentCharacterConfig();

    const agent = await buildBootstrap({
      ...baseRec,
      agent_config: buildAgentSandboxInsertValues({
        organizationId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        agentName: "bnancy",
        executionTier: "dedicated-always",
      }).agent_config as Record<string, unknown>,
    });

    // The stub fallback is now unreachable for a fresh agent: the persona comes
    // from the row, while the NAME still comes from the agent_name column.
    expect(agent.name).toBe("bnancy");
    expect(agent.system).toBe(seed.system);
    expect(agent.bio).toEqual(seed.bio as string[]);
    expect(agent.style).toEqual(seed.style as { all?: string[] });
    expect(agent.system).not.toBe("You are bnancy, a helpful assistant.");
  });
});

/**
 * Provision admission is a fail-closed service boundary as well as a provider
 * boundary. These rows carry every early-repair tripwire so a rejected tier
 * cannot mutate lifecycle, environment, or credentials before provider.create.
 */
describe("ElizaSandboxService.provision execution-tier admission", () => {
  const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
  const ORG = "22222222-2222-4222-8222-222222222222";

  type ProvisionAdmissionService = {
    provision(
      agentId: string,
      orgId: string,
    ): Promise<{ success: boolean; sandboxRecord?: AgentSandbox; error?: string }>;
    executeResume(
      agentId: string,
      orgId: string,
    ): Promise<{
      success: boolean;
      containerStarted: boolean;
      reprovisioned: boolean;
      error?: string;
    }>;
    retireFailedWarmClaimForRetry(
      agentId: string,
      orgId: string,
    ): Promise<{ success: true } | { success: false; error: string }>;
    retirePersistedReplacementCleanup(agentId: string, orgId: string): Promise<string>;
    provisionAgentDatabase(
      rec: AgentSandbox,
    ): Promise<{ success: boolean; connectionUri?: string; error?: string }>;
  };

  function rejectedRow(executionTier: unknown): AgentSandbox {
    return {
      ...customSandbox(),
      id: AGENT,
      organization_id: ORG,
      execution_tier: executionTier as AgentSandbox["execution_tier"],
      status: "error",
      error_message: "preserve-this-lifecycle-error",
      database_uri: null,
      database_status: "provisioning",
      database_error: "preserve-this-database-error",
      environment_vars: {
        ELIZA_API_TOKEN: "preserve-this-token",
        ELIZAOS_CLOUD_API_KEY: "preserve-this-credential",
      },
      environment_revision: 41,
      lifecycle_revision: 73,
      claimed_at: new Date("2026-08-20T10:00:00.000Z"),
      warm_claim_credential_state: "failed",
      warm_claim_source_pool_id: "77777777-7777-4777-8777-777777777777",
      warm_claim_key_fingerprint: "preserve-this-fingerprint",
      warm_claim_cleanup_completed_at: new Date("2026-08-20T10:05:00.000Z"),
      replacement_cleanup_sandbox_id: "preserve-replacement-sandbox",
      replacement_cleanup_node_id: "preserve-replacement-node",
      replacement_cleanup_container_name: "preserve-replacement-container",
      replacement_cleanup_attempt_id: "88888888-8888-4888-8888-888888888888",
      replacement_cleanup_allocation_counted: true,
      replacement_cleanup_created_at: new Date("2026-08-20T10:06:00.000Z"),
    };
  }

  function untouchedProvider() {
    const create = mock(async (): Promise<SandboxHandle> => {
      throw new Error("execution-tier admission was bypassed");
    });
    const stopForDeletion = mock(async () => ({ kind: "not-running-proven" as const }));
    const stopForReplacement = mock(async () => {});
    const stopOnSpecificNodeForReplacement = mock(async () => {});
    const checkHealth = mock(async () => true);
    const provider: SandboxProvider = {
      create,
      stopForDeletion,
      stopForReplacement,
      stopOnSpecificNodeForReplacement,
      checkHealth,
    };
    return {
      provider,
      create,
      stopForDeletion,
      stopForReplacement,
      stopOnSpecificNodeForReplacement,
      checkHealth,
    };
  }

  for (const [label, executionTier] of [
    ["shared", "shared"],
    ["unknown", "future-container-tier"],
    ["malformed", { tier: "custom" }],
    ["missing", undefined],
  ] as const) {
    test(`rejects ${label} before every observable provision side effect`, async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const row = rejectedRow(executionTier);
      const bytesBefore = JSON.stringify(row);
      const provider = untouchedProvider();
      const svc = new ElizaSandboxService(
        provider.provider,
      ) as unknown as ProvisionAdmissionService;
      const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
      const retireWarmClaim = spyOn(svc, "retireFailedWarmClaimForRetry").mockResolvedValue({
        success: true,
      });
      const retireReplacement = spyOn(svc, "retirePersistedReplacementCleanup").mockResolvedValue(
        "retired",
      );
      const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
        ...row,
        status: "provisioning",
      });
      const provisionDatabase = spyOn(svc, "provisionAgentDatabase").mockResolvedValue({
        success: true,
        connectionUri: "postgres://must-not-be-assigned",
      });
      const update = spyOn(agentSandboxesRepository, "update").mockResolvedValue(row);
      const findById = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
      const createCredential = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
        apiKey: {} as never,
        plainKey: "must-not-be-minted",
        revokedKeyHashes: [],
      });
      const revokeCredential = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue([]);
      reactivateBillingSpy.mockClear();

      try {
        const result = await svc.provision(AGENT, ORG);
        expect(result).toEqual({
          success: false,
          sandboxRecord: row,
          error: "Sandbox provisioning requires an explicit container-backed execution tier",
        });
        expect(JSON.stringify(row)).toBe(bytesBefore);
        expect(find).toHaveBeenCalledTimes(1);
        expect(retireWarmClaim).not.toHaveBeenCalled();
        expect(retireReplacement).not.toHaveBeenCalled();
        expect(lock).not.toHaveBeenCalled();
        expect(provisionDatabase).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(findById).not.toHaveBeenCalled();
        expect(createCredential).not.toHaveBeenCalled();
        expect(revokeCredential).not.toHaveBeenCalled();
        expect(reactivateBillingSpy).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        expect(provider.stopForDeletion).not.toHaveBeenCalled();
        expect(provider.stopForReplacement).not.toHaveBeenCalled();
        expect(provider.stopOnSpecificNodeForReplacement).not.toHaveBeenCalled();
        expect(provider.checkHealth).not.toHaveBeenCalled();
      } finally {
        find.mockRestore();
        retireWarmClaim.mockRestore();
        retireReplacement.mockRestore();
        lock.mockRestore();
        provisionDatabase.mockRestore();
        update.mockRestore();
        findById.mockRestore();
        createCredential.mockRestore();
        revokeCredential.mockRestore();
      }
    });
  }

  for (const executionTier of CONTAINER_BACKED_EXECUTION_TIERS) {
    test(`admits canonical ${executionTier} rows to the atomic provisioning lock`, async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const row: AgentSandbox = {
        ...customSandbox(),
        id: AGENT,
        organization_id: ORG,
        execution_tier: executionTier,
        status: "stopped",
        bridge_url: null,
        health_url: null,
        claimed_at: null,
        warm_claim_credential_state: null,
      };
      const provider = untouchedProvider();
      const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
      const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(
        undefined,
      );
      try {
        const result = await new ElizaSandboxService(provider.provider).provision(AGENT, ORG);
        expect(result).toEqual({
          success: false,
          sandboxRecord: row,
          error: "Agent is already being provisioned",
        });
        expect(lock).toHaveBeenCalledTimes(1);
        expect(lock).toHaveBeenCalledWith(AGENT);
        expect(provider.create).not.toHaveBeenCalled();
      } finally {
        find.mockRestore();
        lock.mockRestore();
      }
    });
  }

  test("service-key resume applies the same admission before billing or provision", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...rejectedRow("shared"),
      status: "stopped",
      claimed_at: null,
      warm_claim_credential_state: null,
      replacement_cleanup_sandbox_id: null,
      replacement_cleanup_node_id: null,
      replacement_cleanup_container_name: null,
      replacement_cleanup_attempt_id: null,
      replacement_cleanup_allocation_counted: null,
      replacement_cleanup_created_at: null,
    };
    const bytesBefore = JSON.stringify(row);
    const provider = untouchedProvider();
    const svc = new ElizaSandboxService(provider.provider) as unknown as ProvisionAdmissionService;
    const getForWrite = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      row,
    );
    const find = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lock = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(undefined);
    settleLifecycleBillingSpy.mockClear();
    try {
      const result = await svc.executeResume(AGENT, ORG);
      expect(result).toEqual({
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Sandbox provisioning requires an explicit container-backed execution tier",
      });
      expect(JSON.stringify(row)).toBe(bytesBefore);
      expect(settleLifecycleBillingSpy).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(lock).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.stopForDeletion).not.toHaveBeenCalled();
      expect(provider.stopForReplacement).not.toHaveBeenCalled();
      expect(provider.stopOnSpecificNodeForReplacement).not.toHaveBeenCalled();
      expect(provider.checkHealth).not.toHaveBeenCalled();
    } finally {
      getForWrite.mockRestore();
      find.mockRestore();
      lock.mockRestore();
    }
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
//   5. all MAX_PROVISION_ATTEMPTS exhausted → "Provisioning failed after 3 attempts"
//      (no "(not retryable)" marker: the last failure was a collision).
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
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
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
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
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

  test("same-repo stale docker_image pin is replaced with the configured fleet image on provision", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const configuredImage = "ghcr.io/elizaos/eliza:sha-current";
    const row = {
      ...provisioningReadyRow(),
      docker_image: "ghcr.io/elizaos/eliza:sha-stale",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const finalRow: AgentSandbox = { ...row, status: "running", docker_image: configuredImage };
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") return finalRow;
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
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);

    try {
      const res = await runWithCloudBindings({ ELIZA_AGENT_IMAGE: configuredImage }, () =>
        svc.provision(AGENT, ORG),
      );
      expect(res.success).toBe(true);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: configuredImage,
        executionTier: "custom",
      });
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

  test("custom-repo docker_image pin is preserved on provision", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const configuredImage = "ghcr.io/elizaos/eliza:sha-current";
    const customImage = "ghcr.io/example/custom-agent:stable";
    const row = {
      ...provisioningReadyRow(),
      docker_image: customImage,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => {
        if (data.status === "running") return finalRow;
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
    const create = mock(async () => providerHandle());
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    } as SandboxProvider);

    try {
      const res = await runWithCloudBindings({ ELIZA_AGENT_IMAGE: configuredImage }, () =>
        svc.provision(AGENT, ORG),
      );
      expect(res.success).toBe(true);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: customImage,
      });
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
      expect(res.error).toBe("connection terminated unexpectedly");
      // A non-unique error is NOT a port collision — must not retry.
      expect(create).toHaveBeenCalledTimes(1);
      // Ghost deletion still runs once for the single failed attempt.
      expect(stop).toHaveBeenCalledTimes(1);
      expect(markErrorSpy).toHaveBeenCalledTimes(1);
      // #22508: the row must record the attempt that was actually made. Naming
      // MAX_PROVISION_ATTEMPTS here made this one-attempt failure look like an
      // exhausted retry budget and sent a live outage down the wrong path.
      expect(markedMessage).toBe(
        "Provisioning failed after 1 attempt (not retryable): connection terminated unexpectedly",
      );
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

  test("post-create cleanup failure preserves the original readiness failure", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }),
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const create = mock(async () => providerHandle());
    const stopForReplacement = mock(async () => {
      throw new Error("remote absence remains unresolved");
    });
    const svc = new ElizaSandboxService();
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stopForReplacement,
      checkHealth: async () => false,
    } as SandboxProvider);

    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res).toEqual(
        expect.objectContaining({
          success: false,
          retryable: true,
          error:
            "Sandbox health check timed out; replacement cleanup remains pending: remote absence remains unresolved",
        }),
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(stopForReplacement).toHaveBeenCalledWith("sandbox-blue-1");
    } finally {
      findSpy.mockRestore();
      findByIdSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
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
      expect(markedMessage).toContain("Provisioning failed after 3 attempts: ");
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

  test("a warm-pool provision becomes running only through the final readiness CAS", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const configuredPoolImage = "ghcr.io/elizaos/eliza:stable";
    const targetDigest = `sha256:${"a".repeat(64)}`;
    const handle = {
      ...providerHandle(),
      metadata: {
        ...providerHandle().metadata,
        dockerImage: `ghcr.io/elizaos/eliza@${targetDigest}`,
        imageDigest: targetDigest,
      },
    };
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      organization_id: WARM_POOL_ORG_ID,
      user_id: WARM_POOL_USER_ID,
      execution_tier: "dedicated-always",
      pool_status: "unclaimed",
      docker_image: configuredPoolImage,
      image_digest: targetDigest,
    };
    const adoptedRow: AgentSandbox = {
      ...row,
      status: "provisioning",
      sandbox_id: handle.sandboxId,
      node_id: handle.metadata.nodeId,
      container_name: handle.metadata.containerName,
      bridge_url: handle.bridgeUrl,
      health_url: handle.healthUrl,
      docker_image: configuredPoolImage,
      image_digest: handle.metadata.imageDigest,
    };
    const readyRow: AgentSandbox = {
      ...adoptedRow,
      status: "running",
      pool_ready_at: new Date("2026-07-30T12:00:00.000Z"),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(row);
    const backupSpy = spyOn(agentSandboxesRepository, "getLatestBackup").mockResolvedValue(
      undefined,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => (data.status === "provisioning" ? adoptedRow : row),
    );
    const commitReadySpy = spyOn(
      agentSandboxesRepository,
      "commitPoolEntryReady",
    ).mockResolvedValue(readyRow);
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const create = mock(async () => handle);
    const provider: SandboxProvider = {
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: async () => true,
    };
    const svc = new ElizaSandboxService(provider);
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);

    try {
      const result = await svc.provision(AGENT, WARM_POOL_ORG_ID);

      expect(result.success).toBe(true);
      expect(result.sandboxRecord).toBe(readyRow);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          dockerImage: `ghcr.io/elizaos/eliza@${targetDigest}`,
        }),
      );
      expect(updateSpy).toHaveBeenCalledWith(
        AGENT,
        expect.objectContaining({
          status: "provisioning",
          docker_image: configuredPoolImage,
          image_digest: targetDigest,
        }),
      );
      expect(updateSpy.mock.calls.some(([, data]) => data.status === "running")).toBe(false);
      expect(commitReadySpy).toHaveBeenCalledTimes(1);
      expect(commitReadySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "provisioning",
          pool_ready_at: null,
          sandbox_id: handle.sandboxId,
          node_id: handle.metadata.nodeId,
          bridge_url: handle.bridgeUrl,
        }),
      );
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      backupSpy.mockRestore();
      updateSpy.mockRestore();
      commitReadySpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
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
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
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
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
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
  // provision() body; the thrown error is from the real core KMS
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
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
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
  // ("Provisioning failed after 1 attempt (not retryable): State restore failed: HTTP 401
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
      // A 401 is an AUTH failure — RECOVERABLE (#15263), not a permanently-lost
      // snapshot. It degrades to a fresh boot so the agent never bricks, but the
      // backup chain is PRESERVED so a later token-corrected resume can restore
      // it. Pruning here would be silent, permanent data loss (#15274), so the
      // chain-nuking `pruneBackups(agentId, 0)` must NOT fire on this path.
      expect(pruneSpy).not.toHaveBeenCalledWith(AGENT, 0);
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
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
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

  test("(9) readiness probe transport_unresolved → retryable, container NOT stopped, handle persisted, status stays provisioning (#15310 #6)", async () => {
    // The false-negative split-brain: the post-create readiness probe never
    // reaches the (likely-healthy) container. provision() must NOT tear the
    // container down and NOT markError; it must PERSIST the container handle so
    // the daemon reconciler can find + re-probe the row, and return retryable
    // so the job retries instead of permanently failing.
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }) as AgentSandbox,
    );
    const stop = mock(async () => {});
    const create = mock(async () => providerHandle());
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
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(
      replacementAwareProvider({
        create,
        stop,
        checkHealth: async () => false,
        checkHealthDetailed: async () => ({
          ready: false,
          verdict: "transport_unresolved" as const,
        }),
      } as unknown as SandboxProvider),
    );

    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect((res as { retryable?: boolean }).retryable).toBe(true);
      // The healthy container is NEVER torn down on a transport-unresolved probe.
      expect(stop).not.toHaveBeenCalled();
      // The container handle IS persisted (so the reconciler can find the row),
      // and NO write flips it to `running` (only a confirmed re-probe may).
      const persistWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { sandbox_id?: string }).sandbox_id === "sandbox-blue-1",
      );
      expect(persistWrite).toBeDefined();
      const flippedRunning = updateSpy.mock.calls.some(
        ([, data]) => (data as { status?: string }).status === "running",
      );
      expect(flippedRunning).toBe(false);
      // Not marked error either.
      const markedError = updateSpy.mock.calls.some(
        ([, data]) => (data as { status?: string }).status === "error",
      );
      expect(markedError).toBe(false);
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      findByIdSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(9b) transport_unresolved docker handle without node_id fails closed instead of preserving an orphan handle", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row = provisioningReadyRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue({
      ...row,
      status: "provisioning",
    });
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }) as AgentSandbox,
    );
    const stop = mock(async () => {});
    const create = mock(async () => ({
      ...providerHandle(),
      metadata: {
        provider: "docker" as const,
        nodeId: "",
        hostname: "node-2.internal",
        containerName: "agent-blue-1",
      },
    }));
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
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(
      replacementAwareProvider({
        create,
        stop,
        checkHealth: async () => false,
        checkHealthDetailed: async () => ({
          ready: false,
          verdict: "transport_unresolved" as const,
        }),
      } as unknown as SandboxProvider),
    );

    try {
      const res = await svc.provision(AGENT, ORG);
      expect(res.success).toBe(false);
      expect((res as { retryable?: boolean }).retryable).not.toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(
        updateSpy.mock.calls.some(
          ([, data]) => (data as { sandbox_id?: string }).sandbox_id === "sandbox-blue-1",
        ),
      ).toBe(false);
      const errorWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { status?: string }).status === "error",
      );
      expect(errorWrite).toBeDefined();
      if (!errorWrite) {
        throw new Error("Expected the failed-provision error write");
      }
      expect(String((errorWrite[1] as { error_message?: string }).error_message)).toContain(
        "provision attribution guard:",
      );
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      findByIdSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });

  test("(10) retry after transport_unresolved adopts the persisted container instead of re-creating it", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      status: "provisioning",
      sandbox_id: "sandbox-blue-1",
      bridge_url: "https://runtime-blue.example",
      health_url: "https://runtime-blue.example/api/health",
      node_id: "node-blue",
      container_name: "agent-blue-1",
      bridge_port: 3333,
      web_ui_port: 4444,
      headscale_ip: "100.64.0.42",
    };
    const finalRow: AgentSandbox = { ...row, status: "running" };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(row);
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
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const healthInputs: Array<{ sandboxId: string }> = [];
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue({
      create,
      stop,
      checkHealth: async () => true,
      checkHealthDetailed: async (handle) => {
        healthInputs.push({ sandboxId: handle.sandboxId });
        return { ready: true, verdict: "ready" as const };
      },
    } as unknown as SandboxProvider);

    try {
      const res = await svc.provision(AGENT, ORG);

      expect(res.success).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(healthInputs).toEqual([{ sandboxId: "sandbox-blue-1" }]);
      const runningWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { status?: string }).status === "running",
      );
      expect(runningWrite).toBeDefined();
      if (!runningWrite) {
        throw new Error("Expected the adopted sandbox running write");
      }
      expect((runningWrite[1] as { sandbox_id?: string }).sandbox_id).toBe("sandbox-blue-1");
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

  test("(10b) retry adoption refuses persisted docker container without node_id", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const row: AgentSandbox = {
      ...provisioningReadyRow(),
      status: "provisioning",
      sandbox_id: "sandbox-blue-1",
      bridge_url: "https://runtime-blue.example",
      health_url: "https://runtime-blue.example/api/health",
      node_id: null,
      container_name: "agent-blue-1",
      bridge_port: 3333,
      web_ui_port: 4444,
      headscale_ip: "100.64.0.42",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(row);
    const lockSpy = spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(row);
    const findByIdSpy = spyOn(agentSandboxesRepository, "findById").mockResolvedValue(row);
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, data) => ({ ...row, ...data }) as AgentSandbox,
    );
    const apiKeySpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_test_agent_key",
      prefix: "eliza_test",
    });
    const create = mock(async () => providerHandle());
    const stop = mock(async () => {});
    const healthInputs: Array<{ sandboxId: string; metadata?: Record<string, unknown> }> = [];
    const svc = new ElizaSandboxService();
    const ensureStartedSpy = spyOn(
      svc as unknown as { ensureRuntimeAgentStarted: () => Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    const getProviderSpy = spyOn(
      svc as unknown as { getProvider: () => Promise<SandboxProvider> },
      "getProvider",
    ).mockResolvedValue(
      replacementAwareProvider({
        create,
        stop,
        checkHealth: async () => true,
        checkHealthDetailed: async (handle) => {
          healthInputs.push({ sandboxId: handle.sandboxId, metadata: handle.metadata });
          return { ready: true, verdict: "ready" as const };
        },
      } as unknown as SandboxProvider),
    );

    try {
      const res = await svc.provision(AGENT, ORG);

      expect(res.success).toBe(false);
      expect(create).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(healthInputs).toEqual([
        {
          sandboxId: "sandbox-blue-1",
          metadata: {
            provider: "docker",
            nodeId: "",
            hostname: "",
            containerName: "agent-blue-1",
            bridgePort: 3333,
            webUiPort: 4444,
            headscaleIp: "100.64.0.42",
          },
        },
      ]);
      expect(
        updateSpy.mock.calls.some(([, data]) => (data as { status?: string }).status === "running"),
      ).toBe(false);
      const errorWrite = updateSpy.mock.calls.find(
        ([, data]) => (data as { status?: string }).status === "error",
      );
      expect(errorWrite).toBeDefined();
      if (!errorWrite) {
        throw new Error("Expected the invalid-adoption error write");
      }
      expect(String((errorWrite[1] as { error_message?: string }).error_message)).toContain(
        "provision attribution guard:",
      );
    } finally {
      findSpy.mockRestore();
      lockSpy.mockRestore();
      findByIdSpy.mockRestore();
      updateSpy.mockRestore();
      apiKeySpy.mockRestore();
      ensureStartedSpy.mockRestore();
      getProviderSpy.mockRestore();
    }
  });
});

// Snapshot-degrade error classification (`isUnrecoverableSnapshotError`), proven
// against real core KMS errors produced by the crypto stack — the
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
    // #18228: a diagnostic body suffix must not change transient-vs-permanent
    // classification — the regex is anchored at the status prefix.
    expect(
      isUnrecoverableSnapshotError(
        new Error("Snapshot fetch failed: HTTP 500 Durable Object storage quota exceeded"),
      ),
    ).toBe(false);
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
          'Provisioning failed after 1 attempt (not retryable): State restore failed: HTTP 401 {"error":"Unauthorized"}',
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

// Snapshot PRUNE-gating classification (`isPermanentlyLostSnapshot`, #15274).
// A strict SUBSET of `isUnrecoverableSnapshotError`: an auth 401/403 is
// unrecoverable for THIS provision (boot fresh) but the snapshot is NOT
// permanently lost — a token-corrected resume (#15263) can still restore it —
// so it must NEVER gate a `pruneBackups(agentId, 0)`. Only crypto-loss and
// HTTP 404/410 are permanently lost and safe to prune.
describe("isPermanentlyLostSnapshot (prune-vs-preserve gating)", () => {
  test("classifies crypto-loss shapes (KeyNotFoundError / AeadError) as permanently lost", async () => {
    const { isPermanentlyLostSnapshot } = await import("./eliza-sandbox.ts?actual");
    const keyGone = await realKeyRotatedAwayError();
    expect(keyGone).toBeInstanceOf(KeyNotFoundError);
    expect(isPermanentlyLostSnapshot(keyGone)).toBe(true);
    const corrupt = await realAeadDecryptError();
    expect(corrupt.name).toBe("AeadError");
    expect(isPermanentlyLostSnapshot(corrupt)).toBe(true);
  });

  test("classifies HTTP 404/410 (snapshot gone) as permanently lost — safe to prune", async () => {
    const { isPermanentlyLostSnapshot } = await import("./eliza-sandbox.ts?actual");
    expect(isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 404 Not Found"))).toBe(
      true,
    );
    expect(isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 410 Gone"))).toBe(true);
    expect(isPermanentlyLostSnapshot(new Error("Snapshot fetch failed: HTTP 410"))).toBe(true);
  });

  test("does NOT classify auth 401/403 as permanently lost — recoverable, must PRESERVE the chain (#15274)", async () => {
    const { isPermanentlyLostSnapshot, isUnrecoverableSnapshotError } = await import(
      "./eliza-sandbox.ts?actual"
    );
    // The exact HQ 14308 incident string. It IS unrecoverable-for-this-provision
    // (degrade to fresh boot) but NOT permanently lost: PR #15263 shows the 401
    // was a healthy container missing the agent token, which a corrected resume
    // restores. Pruning here = silent permanent data loss.
    const auth401 = new Error('State restore failed: HTTP 401 {"error":"Unauthorized"}');
    expect(isUnrecoverableSnapshotError(auth401)).toBe(true);
    expect(isPermanentlyLostSnapshot(auth401)).toBe(false);
    const auth403 = new Error("State restore failed: HTTP 403 ");
    expect(isUnrecoverableSnapshotError(auth403)).toBe(true);
    expect(isPermanentlyLostSnapshot(auth403)).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("Snapshot fetch failed: HTTP 401"))).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("Snapshot fetch failed: HTTP 403"))).toBe(false);
  });

  test("does NOT classify transient / non-matching errors as permanently lost", async () => {
    const { isPermanentlyLostSnapshot } = await import("./eliza-sandbox.ts?actual");
    // Transient HTTP and network/DB errors were never unrecoverable to begin
    // with; they must never prune.
    expect(
      isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 500 Internal Server Error")),
    ).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 503 "))).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("connection terminated unexpectedly"))).toBe(false);
    expect(isPermanentlyLostSnapshot(new TypeError("fetch failed"))).toBe(false);
    expect(isPermanentlyLostSnapshot("AEAD decrypt failed")).toBe(false);
    expect(isPermanentlyLostSnapshot(null)).toBe(false);
    expect(isPermanentlyLostSnapshot(undefined)).toBe(false);
  });
});

describe("replacement runtime authentication contract", () => {
  test("keeps /api/status protected while only GET /api/health bypasses authentication", () => {
    const agentApiDirectory = new URL("../../../../../agent/src/api/", import.meta.url);
    const routeClassifierSource = readFileSync(
      new URL("static-file-server.ts", agentApiDirectory),
      "utf8",
    );
    const serverSource = readFileSync(new URL("server.ts", agentApiDirectory), "utf8");

    // Both endpoints enter the normal protected /api namespace. The agent
    // server then exempts only the public liveness probe; rollout identity and
    // startup checks deliberately use /api/status so a missing or rejected
    // agent token fails before the public readiness probe can pass.
    expect(routeClassifierSource).toMatch(
      /export function isAuthProtectedRoute\(pathname: string\): boolean \{[\s\S]*pathname\.startsWith\("\/api\/"\)/,
    );
    expect(serverSource).toContain(
      'const isHealthEndpoint = method === "GET" && pathname === "/api/health";',
    );

    const authGateStart = serverSource.indexOf(
      'method !== "OPTIONS" &&\n    isAuthProtectedPath &&',
    );
    const authGateEnd = serverSource.indexOf(
      'json(res, { error: "Unauthorized" }, 401);',
      authGateStart,
    );
    expect(authGateStart).toBeGreaterThan(-1);
    expect(authGateEnd).toBeGreaterThan(authGateStart);

    const authGate = serverSource.slice(authGateStart, authGateEnd);
    expect(authGate).toContain("!isHealthEndpoint");
    expect(authGate).not.toContain('"/api/status"');
    expect(authGate).not.toContain("isStatusEndpoint");
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
  const OWNER = "33333333-3333-4333-8333-333333333333";
  const DOCKER_IMAGE = "ghcr.io/elizaos/eliza-agent:latest";
  const FROM_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000aaa";
  const TO_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111bbb";

  function runtimeStatusResponse(
    body: Record<string, unknown> = {
      state: "running",
      canRespond: true,
      startup: { phase: "running", attempt: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function runtimeHealthResponse(
    body: Record<string, unknown> = {
      ready: true,
      canRespond: true,
      runtime: "ok",
      database: "ok",
      plugins: { loaded: 18, failed: 0 },
      startup: { phase: "running", attempt: 0 },
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
      allocated_count: 1,
    } as unknown as DockerNode;
  }

  // A genuine DockerSandboxMetadata for blue — isDockerSandboxMetadata() passes.
  function blueMetadata(imageDigest: string | null, previousVpnNodeId?: string) {
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
      ...(previousVpnNodeId ? { previousVpnNodeId } : {}),
    };
  }

  function blueHandle(imageDigest: string | null, previousVpnNodeId?: string) {
    return {
      sandboxId: "sandbox-new-1",
      bridgeUrl: "https://new-bridge.example",
      healthUrl: "https://new-bridge.example/health",
      metadata: blueMetadata(imageDigest, previousVpnNodeId),
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
    Object.assign(provider, {
      create,
      checkHealth,
      stop,
      stopOnSpecificNodeForReplacement: stopOnSpecificNode,
    });
    replacementAwareProvider(provider as unknown as SandboxProvider);
    const runtimeFetch = mock(async (input: RequestInfo | URL, _init?: RequestInit) =>
      fetchUrl(input).endsWith("/api/status") ? runtimeStatusResponse() : runtimeHealthResponse(),
    );
    globalThis.fetch = runtimeFetch as unknown as typeof fetch;
    return {
      provider: provider as unknown as SandboxProvider,
      create,
      checkHealth,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
    };
  }

  afterEach(() => {
    upgradeTransactionImpl = null;
  });

  test("a pending warm-claim credential fence blocks blue provisioning", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = {
      ...liveAgentRow(),
      claimed_at: new Date("2026-07-23T00:00:00.000Z"),
      warm_claim_credential_state: "pending" as const,
      warm_claim_source_pool_id: "44444444-4444-4444-8444-444444444444",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId");
    try {
      const res = await new ElizaSandboxService().executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res).toMatchObject({
        success: false,
        rolledBack: true,
        error: "Warm-claim credential handoff is not ready",
      });
      expect(nodeSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(a) blue health-check FAILS → blue torn down, row stays on OLD, rolled-back error", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
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
      expect(res.error).toContain("kept agent on old container");
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
      // The unhealthy blue is retired through the durable placement locator.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
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
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const WRONG_DIGEST = "sha256:dededededededededededededededededededededededededededededede0000";
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
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
      // Serving the WRONG image would silently ship an unintended build — retire
      // the exact durable blue placement and never target the live sandbox.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
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
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const runtimeFetch = mock(async (input: RequestInfo | URL) =>
      fetchUrl(input).endsWith("/api/status")
        ? runtimeStatusResponse()
        : runtimeHealthResponse({
            ready: false,
            canRespond: false,
            runtime: "ok",
            database: "ok",
            plugins: { loaded: 17, failed: 1 },
            agentState: "starting",
            startup: { phase: "error", attempt: 1, lastError: "migration failed" },
          }),
    );
    globalThis.fetch = runtimeFetch as unknown as typeof fetch;
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
      expect(res.error).toContain("canRespond=false");
      expect(res.error).toContain("plugins.failed=1");
      expect(res.error).toContain("migration failed");
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://new-bridge.example/api/status",
        "https://new-bridge.example/api/health",
      ]);
      expect(snapshotSpy).not.toHaveBeenCalled();
      expect(transactionCalled).toBe(false);
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(checkHealth).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  }, 20_000);

  for (const missing of ["plugins", "startup"] as const) {
    test(`upgrade runtime readiness fails closed when ${missing} structure is missing`, async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const agent = liveAgentRow();
      const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
        agent,
      );
      const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
      const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
        create: async () => blueHandle(TO_DIGEST),
        checkHealth: async () => true,
      });
      const runtimeFetch = mock(async (input: RequestInfo | URL) =>
        fetchUrl(input).endsWith("/api/status")
          ? runtimeStatusResponse()
          : runtimeHealthResponse({
              ready: true,
              runtime: "ok",
              database: "ok",
              ...(missing === "plugins" ? {} : { plugins: { loaded: 18, failed: 0 } }),
              ...(missing === "startup" ? {} : { startup: { phase: "running", attempt: 0 } }),
            }),
      );
      globalThis.fetch = runtimeFetch as unknown as typeof fetch;
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
        const result = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
        expect(result.success).toBe(false);
        expect(result.error).toContain(`Blue runtime readiness gate failed`);
        expect(result.error).toContain(`${missing}=missing`);
        expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
          "https://new-bridge.example/api/status",
          "https://new-bridge.example/api/health",
        ]);
        expect(snapshotSpy).not.toHaveBeenCalled();
        expect(transactionCalled).toBe(false);
        expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
        expect(stopOnSpecificNode).toHaveBeenCalledWith(
          "node-new",
          "agent-new-1",
          null,
          expect.objectContaining({
            replacementAttemptId: expect.any(String),
            containerId: "container-sandbox-new-1",
          }),
        );
        expect(stop).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
        nodeSpy.mockRestore();
        snapshotSpy.mockRestore();
      }
    });
  }

  test("(c) happy path → atomic swap writes blue's node/container/bridge + image_digest=toDigest", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent: AgentSandbox = {
      ...liveAgentRow(),
      execution_tier: "dedicated-always",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, checkHealth, stop, stopOnSpecificNode, runtimeFetch } =
      await makeDockerProvider({
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
      // Success clears the upgrade-exhaustion marker: a row frozen for a prior
      // target re-arms the moment a swap onto a new target lands (#15358).
      const updateSql = new PgDialect().sqlToQuery(executedSql as SQL).sql.toLowerCase();
      expect(updateSql).toContain("error_message = null");
      // The old container is best-effort torn down on its specific node; the
      // blue is the live one and is NOT stopped.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        executionTier: "dedicated-always",
      });
      expect(checkHealth).toHaveBeenCalledTimes(1);
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://new-bridge.example/api/status",
        "https://new-bridge.example/api/health",
      ]);
      for (const call of runtimeFetch.mock.calls) {
        expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer agent-token");
      }
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("(h1) upgrade forces a stored direct-relay opt-in off while preserving the live VPN node (#16565)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const liveAgent = liveAgentRow();
    const agent = {
      ...liveAgent,
      environment_vars: {
        ...(liveAgent.environment_vars as Record<string, string>),
        ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      },
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST, "old-live-node-7"),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
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
    const snapshotSpy = spyOn(
      svc as unknown as {
        snapshot: (...a: unknown[]) => Promise<{ success: boolean }>;
      },
      "snapshot",
    ).mockResolvedValue({ success: true });
    // Event order: the old placement retirement must start only after the swap.
    // The provider's replacement-cleanup suite owns the remote Docker/Headscale
    // mechanics; this orchestration suite verifies the exact VPN id is delegated.
    const events: string[] = [];
    stopOnSpecificNode.mockImplementation(async () => {
      events.push("old-teardown");
    });
    upgradeTransactionImpl = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => {
          events.push("swap-commit");
          return { rows: [{ id: AGENT }] };
        },
      };
      return fn(tx);
    };
    try {
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      expect(res.success).toBe(true);
      // Blue was provisioned in preserve mode.
      const createConfig = create.mock.calls[0]?.[0] as
        | {
            reclaimStaleVpnNode?: boolean;
            environmentVars?: Record<string, string>;
          }
        | undefined;
      expect(createConfig?.reclaimStaleVpnNode).toBe(false);
      expect(createConfig?.environmentVars?.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("0");
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-old",
        "agent-old-1",
        "old-live-node-7",
        expect.objectContaining({
          replacementAttemptId: null,
          previousVpnNodeId: null,
        }),
      );
      expect(events).toEqual(["swap-commit", "old-teardown"]);
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("(h2) rolled-back upgrade never deletes the preserved live node (#16565)", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST, "old-live-node-7"),
      checkHealth: async () => false, // blue never comes up → rollback
    });
    try {
      const res = await new ElizaSandboxService(provider).executeUpgrade(
        AGENT,
        ORG,
        TO_DIGEST,
        DOCKER_IMAGE,
        FROM_DIGEST,
      );
      expect(res.success).toBe(false);
      expect(res.rolledBack).toBe(true);
      // Blue is torn down; the preserved live node is left untouched — the
      // agent keeps serving on old.
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          previousVpnNodeId: "old-live-node-7",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("(c2) pre-upgrade snapshot failure → blue torn down, NO swap", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent = liveAgentRow();
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
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
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
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
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
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
      // The orphaned blue (built but never adopted) is retired by its exact
      // placement identity; the old container stays live.
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
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

  // Shared driver for the CAS docker_image-leg cases (#15358): run a full
  // executeUpgrade with the given row at BOTH the pre-provision read and the
  // in-transaction CAS read, and report whether the swap UPDATE was issued.
  async function runSwapWithRow(agentRow: AgentSandbox, casRow: AgentSandbox = agentRow) {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agentRow,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
    const lockSpy = spyOn(
      svc as unknown as { lockLifecycle: (...a: unknown[]) => Promise<void> },
      "lockLifecycle",
    ).mockResolvedValue(undefined);
    const readSpy = spyOn(
      svc as unknown as {
        getAgentForLifecycleMutation: (...a: unknown[]) => Promise<AgentSandbox | undefined>;
      },
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(casRow);
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
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
      const res = await svc.executeUpgrade(AGENT, ORG, TO_DIGEST, DOCKER_IMAGE, FROM_DIGEST);
      return { res, executedSql, stop, stopOnSpecificNode };
    } finally {
      findSpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  }

  test("(e1) EMPTY docker_image pin + configured ref → CAS admits, swap proceeds (#15358)", async () => {
    // 45 running prod agents carry an empty docker_image; an exact-ref CAS
    // treated "" !== configured ref as a concurrent change and abandoned the
    // swap AFTER the blue provision + snapshot, every attempt, until the
    // upgrade exhausted and the failure marker froze the agent.
    const row: AgentSandbox = { ...liveAgentRow(), docker_image: "" };
    const { res, executedSql } = await runSwapWithRow(row);
    expect(res.success).toBe(true);
    expect(executedSql).toBeDefined();
    expect(sqlBoundParams(executedSql)).toContain(TO_DIGEST);
    expect(sqlBoundParams(executedSql)).toContain(DOCKER_IMAGE);
  });

  test("(e2) same-repo different-tag pin → CAS admits, swap proceeds (#15358)", async () => {
    // A digest-drifted fleet agent pinned to an older tag of the SAME repo is
    // exactly what selection admits (#15101 repo-match); the CAS must mirror
    // that, or every selected sha-pinned agent churns provision→abandon.
    const PINNED = "ghcr.io/elizaos/eliza-agent:sha-519b5d8";
    const row: AgentSandbox = { ...liveAgentRow(), docker_image: PINNED };
    const { res, executedSql } = await runSwapWithRow(row);
    expect(res.success).toBe(true);
    // The pinned ref (not the configured one) is preserved as the rollback image.
    expect(sqlBoundParams(executedSql)).toContain(PINNED);
  });

  test("(e3) CONCURRENT repoint at a DIFFERENT repo → CAS abandons, blue torn down (#15358)", async () => {
    // The CAS's true purpose: the user switched the agent to a custom image
    // while the blue provisioned — adopting the blue would clobber that choice.
    const movedRow: AgentSandbox = {
      ...liveAgentRow(),
      docker_image: "ghcr.io/acme/custom-agent:latest",
    };
    const { res, executedSql, stop, stopOnSpecificNode } = await runSwapWithRow(
      liveAgentRow(),
      movedRow,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("Agent changed during upgrade");
    // No UPDATE was issued and the orphaned blue is stopped.
    expect(executedSql).toBeUndefined();
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-new",
      "agent-new-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-new-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("admin canary requires reported blue digest and uses the primary exact-pair read", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = `ghcr.io/elizaos/eliza-demo@${FROM_DIGEST}`;
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = { ...liveAgentRow(), docker_image: SOURCE_IMAGE };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const replicaSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(null),
      checkHealth: async () => true,
    });
    let transactionCalled = false;
    upgradeTransactionImpl = async () => {
      transactionCalled = true;
      return false as never;
    };
    try {
      const result = await new ElizaSandboxService(provider).executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("got missing");
      expect(primarySpy).toHaveBeenCalledTimes(1);
      expect(replicaSpy).not.toHaveBeenCalled();
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
      expect(transactionCalled).toBe(false);
    } finally {
      primarySpy.mockRestore();
      replicaSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("admin canary refuses an ownership change before provisioning blue", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const movedAgent: AgentSandbox = {
      ...liveAgentRow(),
      user_id: "44444444-4444-4444-8444-444444444444",
      docker_image: SOURCE_IMAGE,
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      movedAgent,
    );
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    try {
      const result = await new ElizaSandboxService(provider).executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("audited canary source image pair");
      expect(create).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
    }
  });

  test("admin canary exact CAS persists target repo+digest and exact rollback pair", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = {
      ...liveAgentRow(),
      docker_image: SOURCE_IMAGE,
      execution_tier: "dedicated-lazy",
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
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
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
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
      const result = await svc.executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(true);
      const params = sqlBoundParams(executedSql);
      expect(params).toContain(TARGET_IMAGE);
      expect(params).toContain(TO_DIGEST);
      expect(params).toContain(SOURCE_IMAGE);
      expect(params).toContain(FROM_DIGEST);
      expect(params).toContain(OWNER);
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        executionTier: "dedicated-lazy",
      });
    } finally {
      primarySpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("admin canary audit failure rolls back cutover and tears down blue", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = { ...liveAgentRow(), docker_image: SOURCE_IMAGE };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
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
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
    const audit = mock(async () => {
      throw new Error("durable audit write failed");
    });
    upgradeTransactionImpl = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => ({ rows: [{ id: AGENT }] }),
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: audit,
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("durable audit write failed");
      expect(audit).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-new",
        "agent-new-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-new-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
      nodeSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  test("admin canary keeps committed success when old-container and VPN cleanup fail", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TO_DIGEST}`;
    const agent: AgentSandbox = { ...liveAgentRow(), docker_image: SOURCE_IMAGE };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(oldNode());
    const { provider, stop, stopOnSpecificNode } = await makeDockerProvider({
      create: async () => blueHandle(TO_DIGEST, "vpn-old"),
      checkHealth: async () => true,
    });
    stopOnSpecificNode.mockImplementation(async () => {
      throw new Error("old container teardown unavailable");
    });
    const svc = new ElizaSandboxService(provider);
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
    const snapshotSpy = spyOn(
      svc as unknown as { snapshot: (...a: unknown[]) => Promise<{ success: boolean }> },
      "snapshot",
    ).mockResolvedValue({ success: true });
    const audit = mock(() => Promise.resolve());
    upgradeTransactionImpl = async (fn) => {
      const tx: UpgradeTx = {
        execute: async () => ({ rows: [{ id: AGENT }] }),
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryUpgrade({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: FROM_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TO_DIGEST,
        onCutoverInTx: audit,
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(true);
      expect(result.cleanupPending).toBe(true);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-old",
        "agent-old-1",
        "vpn-old",
        expect.objectContaining({
          replacementAttemptId: null,
          previousVpnNodeId: null,
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    } finally {
      primarySpy.mockRestore();
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
  const OWNER = "33333333-3333-4333-8333-333333333333";
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
      allocated_count: 1,
    } as unknown as DockerNode;
  }

  function blueMetadata(imageDigest: string | null, previousVpnNodeId?: string) {
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
      ...(previousVpnNodeId ? { previousVpnNodeId } : {}),
    };
  }

  function blueHandle(imageDigest: string | null, previousVpnNodeId?: string) {
    return {
      sandboxId: "sandbox-rb-1",
      bridgeUrl: "https://rb-bridge.example",
      healthUrl: "https://rb-bridge.example/health",
      metadata: blueMetadata(imageDigest, previousVpnNodeId),
    };
  }

  function runtimeStatusResponse(
    body: Record<string, unknown> = {
      state: "running",
      canRespond: true,
      startup: { phase: "running", attempt: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function runtimeHealthResponse(
    body: Record<string, unknown> = {
      ready: true,
      canRespond: true,
      runtime: "ok",
      database: "ok",
      plugins: { loaded: 18, failed: 0 },
      startup: { phase: "running", attempt: 0 },
    },
    status = 200,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function makeDockerProvider(overrides: {
    create: () => Promise<unknown>;
    checkHealth: () => Promise<boolean>;
    runtimeStatus?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
    runtimeHealth?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
  }) {
    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    const provider = new DockerSandboxProvider();
    const create = mock(overrides.create);
    const checkHealth = mock(overrides.checkHealth);
    const stop = mock(async () => {});
    const stopOnSpecificNode = mock(async () => {});
    Object.assign(provider, {
      create,
      checkHealth,
      stop,
      stopOnSpecificNodeForReplacement: stopOnSpecificNode,
    });
    replacementAwareProvider(provider as unknown as SandboxProvider);
    const runtimeFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) =>
      fetchUrl(input).endsWith("/api/status")
        ? await (overrides.runtimeStatus?.(input, init) ?? runtimeStatusResponse())
        : await (overrides.runtimeHealth?.(input, init) ?? runtimeHealthResponse()),
    );
    globalThis.fetch = runtimeFetch as unknown as typeof fetch;
    return {
      provider: provider as unknown as SandboxProvider,
      create,
      checkHealth,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
    };
  }

  afterEach(() => {
    upgradeTransactionImpl = null;
  });

  async function runAdminCanaryRollback(options: {
    onCutoverInTx: () => Promise<void>;
    failPostCutoverCleanup?: boolean;
    runtimeStatus?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
    runtimeHealth?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
    environmentVars?: Record<string, string>;
    targetImage?: string;
    targetDigest?: string;
  }) {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = `ghcr.io/elizaos/eliza-demo@${CURRENT_DIGEST}`;
    const TARGET_IMAGE = options.targetImage ?? "ghcr.io/elizaos/eliza:sha-production";
    const TARGET_DIGEST = options.targetDigest ?? PREV_DIGEST;
    const agent: AgentSandbox = {
      ...upgradedAgentRow(),
      docker_image: SOURCE_IMAGE,
      previous_docker_image: TARGET_IMAGE,
      ...(options.environmentVars ? { environment_vars: options.environmentVars } : {}),
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(curNode());
    const backup = {
      id: "backup-admin-canary-adversarial",
      sandbox_record_id: AGENT,
      snapshot_type: "pre-upgrade",
    } as unknown as AgentSandboxBackup;
    const byTypeSpy = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      backup,
    );
    const reconstructSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const lifecycleEvents: string[] = [];
    const { provider, stop, stopOnSpecificNode, runtimeFetch } = await makeDockerProvider({
      create: async () =>
        blueHandle(TARGET_DIGEST, options.failPostCutoverCleanup ? "vpn-old-rollback" : undefined),
      checkHealth: async () => true,
      runtimeStatus: async (input, init) => {
        lifecycleEvents.push("status");
        return options.runtimeStatus
          ? await options.runtimeStatus(input, init)
          : runtimeStatusResponse();
      },
      runtimeHealth: async (input, init) => {
        lifecycleEvents.push("health");
        return options.runtimeHealth
          ? await options.runtimeHealth(input, init)
          : runtimeHealthResponse();
      },
    });
    if (options.failPostCutoverCleanup) {
      stopOnSpecificNode.mockImplementation(async () => {
        throw new Error("rollback old-container teardown unavailable");
      });
    }
    const svc = new ElizaSandboxService(provider);
    const pushSpy = spyOn(
      svc as unknown as { pushState: (...a: unknown[]) => Promise<void> },
      "pushState",
    ).mockImplementation(async () => {
      lifecycleEvents.push("restore");
    });
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
    let transactionCalled = false;
    upgradeTransactionImpl = async (fn) => {
      transactionCalled = true;
      lifecycleEvents.push("swap");
      const tx: UpgradeTx = {
        execute: async () => ({ rows: [{ id: AGENT }] }),
      };
      return fn(tx);
    };
    try {
      const result = await svc.executeAdminCanaryRollback({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: CURRENT_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
        onCutoverInTx: options.onCutoverInTx,
        onConvergedInTx: async () => {},
      });
      return {
        result,
        stop,
        stopOnSpecificNode,
        runtimeFetch,
        lifecycleEvents,
        transactionCalled,
        pushCalls: pushSpy.mock.calls.length,
      };
    } finally {
      primarySpy.mockRestore();
      nodeSpy.mockRestore();
      byTypeSpy.mockRestore();
      reconstructSpy.mockRestore();
      pushSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
    }
  }

  test("no previous_image_digest → refuses, never touches the live agent", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const agent: AgentSandbox = { ...upgradedAgentRow(), previous_image_digest: null };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
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

  const rollbackRuntimeHealthFailures: Array<{
    name: string;
    response: () => Response;
    expectedError: string;
  }> = [
    {
      name: "rejects a 503",
      response: () => runtimeHealthResponse({ error: "Unavailable" }, 503),
      expectedError: "/api/health returned HTTP 503",
    },
    {
      name: "rejects malformed JSON",
      response: () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      expectedError: "/api/health returned malformed JSON",
    },
    {
      name: "rejects a runtime that cannot respond",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          canRespond: false,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 18, failed: 0 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "canRespond=false",
    },
    {
      name: "rejects a missing plugins structure",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins=missing",
    },
    {
      name: "rejects a missing startup structure",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 18, failed: 0 },
        }),
      expectedError: "startup=missing",
    },
    {
      name: "rejects malformed plugin counters",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: "18", failed: "0" },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins.loaded=18",
    },
    {
      name: "rejects a runtime with no loaded plugins",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 0, failed: 0 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins.loaded=0",
    },
    {
      name: "rejects plugin load failures",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 17, failed: 1 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "plugins.failed=1",
    },
    {
      name: "rejects database failures",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "terminal_error",
          plugins: { loaded: 18, failed: 0 },
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "database=terminal_error",
    },
    {
      name: "rejects startup failures",
      response: () =>
        runtimeHealthResponse({
          ready: true,
          runtime: "ok",
          database: "ok",
          plugins: { loaded: 18, failed: 0 },
          startup: { phase: "error", attempt: 1, lastError: "migration failed" },
        }),
      expectedError: "startup.phase=error",
    },
  ];

  const rollbackRuntimeStatusFailures: Array<{
    name: string;
    response: () => Response;
    expectedError: string;
  }> = [
    {
      name: "rejects malformed JSON",
      response: () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      expectedError: "/api/status returned malformed JSON",
    },
    {
      name: "rejects a non-running runtime",
      response: () =>
        runtimeStatusResponse({
          state: "starting",
          canRespond: true,
          startup: { phase: "starting", attempt: 1 },
        }),
      expectedError: "state=starting",
    },
    {
      name: "rejects a runtime that cannot respond",
      response: () =>
        runtimeStatusResponse({
          state: "running",
          canRespond: false,
          startup: { phase: "running", attempt: 0 },
        }),
      expectedError: "canRespond=false",
    },
    {
      name: "rejects missing startup state",
      response: () => runtimeStatusResponse({ state: "running" }),
      expectedError: "startup=missing",
    },
  ];

  for (const scenario of rollbackRuntimeStatusFailures) {
    test(`pre-restore protected status gate ${scenario.name} before public health`, async () => {
      const audit = mock(() => Promise.resolve());
      const {
        result,
        stop,
        stopOnSpecificNode,
        runtimeFetch,
        lifecycleEvents,
        transactionCalled,
        pushCalls,
      } = await runAdminCanaryRollback({
        onCutoverInTx: audit,
        runtimeStatus: async () => scenario.response(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Blue runtime readiness gate failed before state restore");
      expect(result.error).toContain(scenario.expectedError);
      expect(pushCalls).toBe(0);
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://rb-bridge.example/api/status",
      ]);
      expect(lifecycleEvents).toEqual(["status"]);
      expect(transactionCalled).toBe(false);
      expect(audit).not.toHaveBeenCalled();
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    });
  }

  test("pre-restore protected status gate rejects 401 before public health or state mutation", async () => {
    const audit = mock(() => Promise.resolve());
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      runtimeStatus: async () => runtimeStatusResponse({ error: "Unauthorized" }, 401),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Blue runtime readiness gate failed before state restore");
    expect(result.error).toContain("/api/status returned HTTP 401");
    expect(result.oldNodeId).toBe("node-cur");
    expect(result.oldContainerName).toBe("agent-cur-1");
    expect(pushCalls).toBe(0);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(fetchUrl(runtimeFetch.mock.calls[0]![0])).toBe("https://rb-bridge.example/api/status");
    expect(new Headers(runtimeFetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bearer agent-token",
    );
    expect(lifecycleEvents).toEqual(["status"]);
    expect(transactionCalled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("pre-restore runtime gate refuses an unauthenticated request when the API token is absent", async () => {
    const audit = mock(() => Promise.resolve());
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      environmentVars: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("agent API token is unavailable");
    expect(pushCalls).toBe(0);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(lifecycleEvents).toEqual([]);
    expect(transactionCalled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("post-restore protected status gate rejects a lost authorization before public health or swap", async () => {
    const audit = mock(() => Promise.resolve());
    let statusAttempt = 0;
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      runtimeStatus: async () => {
        statusAttempt += 1;
        return statusAttempt === 1
          ? runtimeStatusResponse()
          : runtimeStatusResponse({ error: "Unauthorized" }, 401);
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Blue runtime readiness gate failed after state restore");
    expect(result.error).toContain("/api/status returned HTTP 401");
    expect(result.oldNodeId).toBe("node-cur");
    expect(result.oldContainerName).toBe("agent-cur-1");
    expect(pushCalls).toBe(1);
    expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
      "https://rb-bridge.example/api/status",
      "https://rb-bridge.example/api/health",
      "https://rb-bridge.example/api/status",
    ]);
    for (const call of runtimeFetch.mock.calls) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe("Bearer agent-token");
    }
    expect(lifecycleEvents).toEqual(["status", "health", "restore", "status"]);
    expect(transactionCalled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  for (const scenario of rollbackRuntimeHealthFailures) {
    test(`post-restore runtime gate ${scenario.name}, preserves current primary, and retires blue`, async () => {
      const audit = mock(() => Promise.resolve());
      let healthAttempt = 0;
      const {
        result,
        stop,
        stopOnSpecificNode,
        runtimeFetch,
        lifecycleEvents,
        transactionCalled,
        pushCalls,
      } = await runAdminCanaryRollback({
        onCutoverInTx: audit,
        runtimeHealth: async () => {
          healthAttempt += 1;
          return healthAttempt === 1 ? runtimeHealthResponse() : scenario.response();
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Blue runtime readiness gate failed after state restore");
      expect(result.error).toContain(scenario.expectedError);
      expect(result.oldNodeId).toBe("node-cur");
      expect(result.oldContainerName).toBe("agent-cur-1");
      expect(pushCalls).toBe(1);
      expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
        "https://rb-bridge.example/api/status",
        "https://rb-bridge.example/api/health",
        "https://rb-bridge.example/api/status",
        "https://rb-bridge.example/api/health",
      ]);
      for (const call of runtimeFetch.mock.calls) {
        const healthHeaders = new Headers((call[1] as RequestInit | undefined)?.headers);
        expect(healthHeaders.get("authorization")).toBe("Bearer agent-token");
        expect(healthHeaders.get("x-api-key")).toBe("agent-token");
        expect(healthHeaders.get("x-eliza-token")).toBe("agent-token");
      }
      expect(lifecycleEvents).toEqual(["status", "health", "restore", "status", "health"]);
      expect(transactionCalled).toBe(false);
      expect(audit).not.toHaveBeenCalled();
      expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
      expect(stopOnSpecificNode).toHaveBeenCalledWith(
        "node-rb",
        "agent-rb-1",
        null,
        expect.objectContaining({
          replacementAttemptId: expect.any(String),
          containerId: "container-sandbox-rb-1",
        }),
      );
      expect(stop).not.toHaveBeenCalled();
    });
  }

  test("rollback forces a stored direct-relay opt-in off while restoring the pre-upgrade snapshot", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const upgradedAgent: AgentSandbox = {
      ...upgradedAgentRow(),
      execution_tier: "dedicated-always",
    };
    const agent: AgentSandbox = {
      ...upgradedAgent,
      previous_docker_image: "",
      environment_vars: {
        ...(upgradedAgent.environment_vars as Record<string, string>),
        ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      },
    };
    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
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
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: `ghcr.io/elizaos/eliza-agent@${PREV_DIGEST}`,
        executionTier: "dedicated-always",
        environmentVars: {
          ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
        },
      });
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

  test("admin canary rollback restores and atomically returns to the exact canonical pair", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const SOURCE_IMAGE = `ghcr.io/elizaos/eliza-demo@${CURRENT_DIGEST}`;
    const TARGET_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
    const agent: AgentSandbox = {
      ...upgradedAgentRow(),
      docker_image: SOURCE_IMAGE,
      previous_docker_image: TARGET_IMAGE,
      execution_tier: "dedicated-lazy",
    };
    const primarySpy = spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(
      agent,
    );
    const replicaSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(agent);
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(curNode());
    const backup = {
      id: "backup-admin-canary",
      sandbox_record_id: AGENT,
      snapshot_type: "pre-upgrade",
    } as unknown as AgentSandboxBackup;
    const byTypeSpy = spyOn(agentSandboxesRepository, "getLatestBackupByType").mockResolvedValue(
      backup,
    );
    const reconstructSpy = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockResolvedValue({ memories: [], config: {}, workspaceFiles: {} });
    const { provider, create } = await makeDockerProvider({
      create: async () => blueHandle(PREV_DIGEST),
      checkHealth: async () => true,
    });
    const svc = new ElizaSandboxService(provider);
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
      const result = await svc.executeAdminCanaryRollback({
        agentId: AGENT,
        organizationId: ORG,
        targetOwnerUserId: OWNER,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: CURRENT_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: PREV_DIGEST,
        onCutoverInTx: async () => {},
        onConvergedInTx: async () => {},
      });
      expect(result.success).toBe(true);
      expect(primarySpy).toHaveBeenCalledTimes(1);
      expect(replicaSpy).not.toHaveBeenCalled();
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        dockerImage: `ghcr.io/elizaos/eliza@${PREV_DIGEST}`,
        executionTier: "dedicated-lazy",
      });
      const params = sqlBoundParams(executedSql);
      expect(params).toContain(TARGET_IMAGE);
      expect(params).toContain(PREV_DIGEST);
      expect(params).toContain(SOURCE_IMAGE);
      expect(params).toContain(CURRENT_DIGEST);
    } finally {
      primarySpy.mockRestore();
      replicaSpy.mockRestore();
      nodeSpy.mockRestore();
      byTypeSpy.mockRestore();
      reconstructSpy.mockRestore();
      pushSpy.mockRestore();
      lockSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  test("admin canary rollback audit failure preserves demo and tears down blue", async () => {
    const audit = mock(async () => {
      throw new Error("durable rollback audit write failed");
    });
    const { result, stop, stopOnSpecificNode } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("durable rollback audit write failed");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-rb",
      "agent-rb-1",
      null,
      expect.objectContaining({
        replacementAttemptId: expect.any(String),
        containerId: "container-sandbox-rb-1",
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("admin canary rollback remains successful when post-cutover cleanup fails", async () => {
    const audit = mock(() => Promise.resolve());
    const {
      result,
      stop,
      stopOnSpecificNode,
      runtimeFetch,
      lifecycleEvents,
      transactionCalled,
      pushCalls,
    } = await runAdminCanaryRollback({
      onCutoverInTx: audit,
      failPostCutoverCleanup: true,
    });
    expect(result.success).toBe(true);
    expect(result.cleanupPending).toBe(true);
    expect(pushCalls).toBe(1);
    expect(runtimeFetch.mock.calls.map((call) => fetchUrl(call[0]))).toEqual([
      "https://rb-bridge.example/api/status",
      "https://rb-bridge.example/api/health",
      "https://rb-bridge.example/api/status",
      "https://rb-bridge.example/api/health",
    ]);
    expect(lifecycleEvents).toEqual(["status", "health", "restore", "status", "health", "swap"]);
    expect(transactionCalled).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledTimes(1);
    expect(stopOnSpecificNode).toHaveBeenCalledWith(
      "node-cur",
      "agent-cur-1",
      "vpn-old-rollback",
      expect.objectContaining({
        replacementAttemptId: null,
        previousVpnNodeId: null,
      }),
    );
    expect(stop).not.toHaveBeenCalled();
  });

  test("admin canary rollback restores an immutable demo target from a prior canary", async () => {
    const targetImage = `ghcr.io/elizaos/eliza-demo@${PREV_DIGEST}`;
    const { result, transactionCalled } = await runAdminCanaryRollback({
      onCutoverInTx: async () => {},
      targetImage,
      targetDigest: PREV_DIGEST,
    });

    expect(result.success).toBe(true);
    expect(transactionCalled).toBe(true);
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

describe("ElizaSandboxService updateAgentProfile / updateAgentEnvironment", () => {
  type MutableProfileService = {
    updateAgentProfile(
      agentId: string,
      orgId: string,
      input: { agentName?: string; agentConfig?: Record<string, unknown> },
    ): Promise<AgentSandbox | undefined>;
    updateAgentEnvironment(
      agentId: string,
      orgId: string,
      environmentVars: Record<string, string>,
    ): Promise<AgentSandbox | undefined>;
    prepareManagedLaunchEnvironment(params: {
      agentId: string;
      organizationId: string;
      userId: string;
    }): Promise<
      | {
          sandbox: AgentSandbox;
          environment: { agentApiKey: string };
        }
      | undefined
    >;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
  };

  function installLifecycleUpdateTransaction(
    existing: AgentSandbox | undefined,
    options: { persist?: boolean; authority?: Record<string, unknown> } = {},
  ) {
    let whereClause: SQL | undefined;
    const updateSet = mock((values: Record<string, unknown>) => ({
      where: mock((clause: SQL) => {
        whereClause = clause;
        return {
          returning: mock(async () =>
            existing && options.persist !== false
              ? [{ ...existing, ...values } as AgentSandbox]
              : [],
          ),
        };
      }),
    }));
    const update = mock(() => ({ set: updateSet }));
    const handle = {
      execute: async () => ({ rows: [] }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (options.authority ? [options.authority] : []),
          }),
        }),
      }),
      update,
    } as unknown as UpgradeTx;
    upgradeTransactionImpl = async (fn) => fn(handle);
    return {
      update,
      updateSet,
      handle,
      getWhereClause: () => whereClause,
    };
  }

  async function makeMutableService(existing: AgentSandbox | undefined) {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService() as unknown as MutableProfileService;
    const lock = spyOn(svc, "lockLifecycle").mockResolvedValue(undefined);
    const read = spyOn(svc, "getAgentForLifecycleMutation").mockResolvedValue(existing);
    return { svc, lock, read };
  }

  test("updateAgentProfile merges a partial config edit into the existing config and applies the name", async () => {
    const existing = {
      ...customSandbox(),
      agent_config: { system: "old system", temperature: 0.7 },
    };
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      const result = await svc.updateAgentProfile(existing.id, existing.organization_id, {
        agentName: "Renamed",
        agentConfig: { system: "new system" },
      });
      // A partial config edit must never drop sibling keys (the merge is the
      // whole reason this method exists — a raw update would clobber them).
      expect(tx.updateSet).toHaveBeenCalledWith({
        agent_name: "Renamed",
        agent_config: { system: "new system", temperature: 0.7 },
        updated_at: expect.any(Date),
      });
      expect(result?.agent_name).toBe("Renamed");
      const whereClause = tx.getWhereClause();
      if (!whereClause) throw new Error("profile update did not build a delete fence");
      const query = new PgDialect().sqlToQuery(whereClause);
      expect(query.sql.toLowerCase()).toContain("deletion_attempt_id");
      expect(query.sql.toLowerCase()).toContain("is null");
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile purges unverified existing markers while rejecting caller replacements", async () => {
    const managedDiscord = { mode: "cloud-managed", guildId: "server-owned" };
    const managedDiscordGateway = { gatewayId: "server-owned" };
    const managedGithub = { installationId: "server-owned" };
    const existing = {
      ...customSandbox(),
      agent_config: {
        system: "old system",
        [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
        [AGENT_MANAGED_DISCORD_KEY]: managedDiscord,
        [AGENT_MANAGED_DISCORD_GATEWAY_KEY]: managedDiscordGateway,
        [AGENT_MANAGED_GITHUB_KEY]: managedGithub,
        [AGENT_UPGRADED_FROM_KEY]: "personal:real-owner",
        [AGENT_PERSONAL_CUTOVER_KEY]: { mode: "dedicated", sourceAgentId: "personal:real-owner" },
      },
    };
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      await svc.updateAgentProfile(existing.id, existing.organization_id, {
        agentConfig: {
          system: "new system",
          [AGENT_MANAGED_DISCORD_KEY]: { mode: "caller-forged" },
          [AGENT_UPGRADED_FROM_KEY]: "personal:attacker",
          [AGENT_PERSONAL_CUTOVER_KEY]: null,
        },
      });
      expect(tx.updateSet).toHaveBeenCalledWith({
        agent_config: {
          system: "new system",
          [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
          [AGENT_MANAGED_DISCORD_KEY]: managedDiscord,
          [AGENT_MANAGED_DISCORD_GATEWAY_KEY]: managedDiscordGateway,
          [AGENT_MANAGED_GITHUB_KEY]: managedGithub,
        },
        updated_at: expect.any(Date),
      });
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile name-only edits preserve unrelated server-owned config", async () => {
    const managedDiscord = { mode: "cloud-managed", guildId: "server-owned" };
    const existing = {
      ...customSandbox(),
      agent_config: {
        system: "old system",
        [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
        [AGENT_MANAGED_DISCORD_KEY]: managedDiscord,
      },
    };
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      await svc.updateAgentProfile(existing.id, existing.organization_id, {
        agentName: "Renamed",
      });
      expect(tx.updateSet).toHaveBeenCalledWith({
        agent_name: "Renamed",
        agent_config: existing.agent_config,
        updated_at: expect.any(Date),
      });
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile returns undefined for an unknown/foreign agent and writes nothing", async () => {
    const tx = installLifecycleUpdateTransaction(undefined);
    const { svc, lock, read } = await makeMutableService(undefined);
    try {
      const result = await svc.updateAgentProfile(
        "dddddddd-9999-4999-8999-999999999999",
        "22222222-2222-4222-8222-222222222222",
        { agentName: "Nope" },
      );
      expect(result).toBeUndefined();
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile with no edits returns the row untouched without writing", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      const result = await svc.updateAgentProfile(existing.id, existing.organization_id, {});
      expect(result).toBe(existing);
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentEnvironment writes through the at-rest encryption boundary under the lifecycle lock", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      const result = await svc.updateAgentEnvironment(existing.id, existing.organization_id, {
        MY_FLAG: "on",
      });
      // Without SECRETS_MASTER_KEY the encryptor passes values through
      // (legacy plaintext behavior) — the write must still round through it
      // so configured environments encrypt BYO secrets at rest (#11332).
      expect(tx.updateSet.mock.calls[0]?.[0]).toMatchObject({
        environment_vars: { MY_FLAG: "on" },
        updated_at: expect.any(Date),
      });
      expect(result).toBeDefined();
      if (!result) {
        throw new Error("Expected the updated sandbox environment row");
      }
      expect((result.environment_vars as Record<string, string>).MY_FLAG).toBe("on");
      const whereClause = tx.getWhereClause();
      if (!whereClause) throw new Error("environment update did not build a delete fence");
      const sql = new PgDialect().sqlToQuery(whereClause).sql.toLowerCase();
      expect(sql).toContain("deletion_attempt_id");
      expect(sql).toContain("is null");
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentEnvironment returns undefined for an unknown agent and writes nothing", async () => {
    const tx = installLifecycleUpdateTransaction(undefined);
    const { svc, lock, read } = await makeMutableService(undefined);
    try {
      const result = await svc.updateAgentEnvironment(
        "dddddddd-9999-4999-8999-999999999999",
        "22222222-2222-4222-8222-222222222222",
        { MY_FLAG: "on" },
      );
      expect(result).toBeUndefined();
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("profile and environment writes reject a durable deletion owner before touching the row", async () => {
    const deleting = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-07-23T12:30:00.000Z"),
    };
    const tx = installLifecycleUpdateTransaction(deleting);
    const { svc, lock, read } = await makeMutableService(deleting);
    try {
      await expect(
        svc.updateAgentProfile(deleting.id, deleting.organization_id, {
          agentName: "must-not-write",
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        svc.updateAgentEnvironment(deleting.id, deleting.organization_id, {
          MUST_NOT_WRITE: "true",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("managed launch mints its replacement on the launch transaction, not a second connection", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      apiKey: { id: "replacement-key" },
      plainKey: "eliza_replacement_key",
      revokedKeyHashes: [],
    } as never);
    try {
      await svc.prepareManagedLaunchEnvironment({
        agentId: existing.id,
        organizationId: existing.organization_id,
        userId: existing.user_id,
      });
      // Minting on the global write pool asks for a SECOND connection while
      // this transaction still holds one; concurrent launches then starve the
      // pool and each stalls out at connectionTimeoutMillis.
      expect(mint).toHaveBeenCalledTimes(1);
      expect(mint.mock.calls[0][0]).toMatchObject({
        agentSandboxId: existing.id,
        organizationId: existing.organization_id,
        tx: tx.handle,
      });
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
      mint.mockRestore();
    }
  });

  test("managed launch unwinds the credential rotation when its environment CAS loses", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing, { persist: false });
    const { svc, lock, read } = await makeMutableService(existing);
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      apiKey: { id: "replacement-key" },
      plainKey: "eliza_replacement_key",
      revokedKeyHashes: [],
    } as never);
    const revoke = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined);
    try {
      await expect(
        svc.prepareManagedLaunchEnvironment({
          agentId: existing.id,
          organizationId: existing.organization_id,
          userId: existing.user_id,
        }),
      ).resolves.toBeUndefined();
      expect(mint).toHaveBeenCalledTimes(1);
      // The rotation shares this transaction, so losing the CAS rolls it back.
      // A compensating out-of-band revoke would now delete the RESTORED key and
      // leave the agent with none.
      expect(revoke).not.toHaveBeenCalled();
      expect(tx.update).toHaveBeenCalledTimes(1);
      const whereClause = tx.getWhereClause();
      if (!whereClause) throw new Error("managed launch did not build its ownership CAS");
      const sql = new PgDialect().sqlToQuery(whereClause).sql.toLowerCase();
      expect(sql).toContain("deletion_attempt_id");
      expect(sql).toContain("environment_revision");
      expect(sql).toContain("lifecycle_revision");
      expect(sql).not.toContain("updated_at");
      expect(sql).toContain("claimed_at");
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
      mint.mockRestore();
      revoke.mockRestore();
    }
  });

  test("managed launch never mints when deletion already owns the lifecycle", async () => {
    const deleting = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-07-23T12:30:00.000Z"),
    };
    const tx = installLifecycleUpdateTransaction(deleting);
    const { svc, lock, read } = await makeMutableService(deleting);
    const mint = spyOn(apiKeysService, "createForAgent");
    const revoke = spyOn(apiKeysService, "revokeForAgent");
    try {
      await expect(
        svc.prepareManagedLaunchEnvironment({
          agentId: deleting.id,
          organizationId: deleting.organization_id,
          userId: deleting.user_id,
        }),
      ).resolves.toBeUndefined();
      expect(mint).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      upgradeTransactionImpl = null;
      lock.mockRestore();
      read.mockRestore();
      mint.mockRestore();
      revoke.mockRestore();
    }
  });

  for (const executionTier of ["shared", "future-container-tier"] as const) {
    test(`managed launch rejects ${executionTier} under the lock before mint or environment CAS`, async () => {
      const existing: AgentSandbox = {
        ...customSandbox(),
        execution_tier: executionTier as AgentSandbox["execution_tier"],
      };
      const tx = installLifecycleUpdateTransaction(existing);
      const { svc, lock, read } = await makeMutableService(existing);
      const mint = spyOn(apiKeysService, "createForAgent");
      const revoke = spyOn(apiKeysService, "revokeForAgent");
      try {
        await expect(
          svc.prepareManagedLaunchEnvironment({
            agentId: existing.id,
            organizationId: existing.organization_id,
            userId: existing.user_id,
          }),
        ).rejects.toThrow("requires a container-backed execution tier");
        expect(mint).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(tx.update).not.toHaveBeenCalled();
      } finally {
        upgradeTransactionImpl = null;
        lock.mockRestore();
        read.mockRestore();
        mint.mockRestore();
        revoke.mockRestore();
      }
    });
  }
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
    const { readErrorBodyExcerpt } = await import("./eliza-sandbox.ts?actual");
    expect(await readErrorBodyExcerpt(errorResponse(""))).toBeNull();
    expect(await readErrorBodyExcerpt(new Response(null, { status: 500 }))).toBeNull();
  });

  test("returns null for whitespace-only bodies", async () => {
    const { readErrorBodyExcerpt } = await import("./eliza-sandbox.ts?actual");
    expect(await readErrorBodyExcerpt(errorResponse("   \n\t  "))).toBeNull();
  });

  test("extracts JSON {error} and {message} fields from short bodies", async () => {
    const { readErrorBodyExcerpt } = await import("./eliza-sandbox.ts?actual");
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
    const { readErrorBodyExcerpt } = await import("./eliza-sandbox.ts?actual");
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
    const { readErrorBodyExcerpt } = await import("./eliza-sandbox.ts?actual");
    const body = "y".repeat(600);
    const excerpt = await readErrorBodyExcerpt(
      errorResponse(body, { contentType: "text/plain", splitAtBytes: [256, 512, 700] }),
    );
    expect(excerpt).toBe("y".repeat(512));
    expect(Buffer.byteLength(excerpt ?? "", "utf-8")).toBe(512);
  });

  test("flushes a multi-byte UTF-8 character split across stream chunks", async () => {
    const { readErrorBodyExcerpt } = await import("./eliza-sandbox.ts?actual");
    const excerpt = await readErrorBodyExcerpt(
      errorResponse("😀", { contentType: "text/plain", splitAtBytes: [2] }),
    );
    expect(excerpt).toBe("😀");
  });

  test("truncates at the byte budget without a garbled trailing character", async () => {
    const { readErrorBodyExcerpt } = await import("./eliza-sandbox.ts?actual");
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
    const { readBodyWithinBudget } = await import("./eliza-sandbox.ts?actual");
    const oversized = "x".repeat(2 * 1024 * 1024);
    await expect(readBodyWithinBudget(streamedResponse(oversized), 1024 * 1024)).rejects.toThrow(
      "raw hydration budget",
    );
  });

  test("a body within budget streams through intact", async () => {
    const { readBodyWithinBudget } = await import("./eliza-sandbox.ts?actual");
    const body = JSON.stringify({ ok: true });
    expect(await readBodyWithinBudget(streamedResponse(body), 1024)).toBe(body);
  });

  test("file-count and expanded-byte budgets fail closed before retention", async () => {
    const { assertSnapshotExpandedBudgets } = await import("./eliza-sandbox.ts?actual");
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
    const { readBodyWithinBudget } = await import("./eliza-sandbox.ts?actual");
    // A null-body Response is the real reader-less shape (bun keeps body null).
    expect(await readBodyWithinBudget(new Response(null), 16)).toBe("");
  });

  test("a reader-less response past the budget is rejected, not retained", async () => {
    const { readBodyWithinBudget } = await import("./eliza-sandbox.ts?actual");
    const readerless = {
      body: null,
      text: async () => "x".repeat(2048),
    } as unknown as Response;
    await expect(readBodyWithinBudget(readerless, 1024)).rejects.toThrow("raw hydration budget");
  });

  test("manifest file-sets count every component, taking max(declared, decoded)", async () => {
    const { assertSnapshotExpandedBudgets } = await import("./eliza-sandbox.ts?actual");
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
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
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

    upgradeTransactionImpl = async (fn) => fn({ execute: async () => ({ rows: [] }) });
    const lockSpy = spyOn(service, "lockLifecycle").mockResolvedValue(undefined);
    const currentSpy = spyOn(service, "getAgentForLifecycleMutation").mockResolvedValue(sandbox);
    const persistSpy = spyOn(
      service,
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
      upgradeTransactionImpl = null;
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

// Reversible deletion_pending (#18517 suggestion 3): cancelAgentDeletion turns
// the one-way door back into a running row while the container is still alive
// — atomically cancelling queued agent_delete jobs so the reconciler has
// nothing to re-arm — and refuses whenever teardown may already have begun.
// Drives the transaction body against a fake lifecycle tx (mocked-database
// suite; the transaction wrapper itself is exercised by the PGlite lane).
describe("ElizaSandboxService.cancelAgentDeletion (#18517 reversibility)", () => {
  type CancelSpyTarget = {
    lockLifecycle: (...args: unknown[]) => Promise<void>;
    getAgentForLifecycleMutation: (...args: unknown[]) => Promise<unknown>;
    cancelAgentDeletionTx: (
      tx: unknown,
      agentId: string,
      orgId: string,
    ) => Promise<{ success: boolean; error?: string }>;
  };

  async function makeCancelSvc() {
    const mod = await import("./eliza-sandbox.ts?actual");
    const svc = new mod.ElizaSandboxService();
    return { svc, spyTarget: svc as unknown as CancelSpyTarget };
  }

  function pendingDeletionSandbox(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
    return {
      ...customSandbox(),
      status: "deletion_pending",
      deletion_attempt_id: "44444444-4444-4444-8444-444444444444",
      deletion_started_at: new Date("2026-08-14T00:00:00.000Z"),
      deletion_previous_status: "running",
      deletion_previous_billing_status: "active",
      deletion_previous_shutdown_warning_sent_at: null,
      deletion_previous_scheduled_shutdown_at: null,
      billing_status: "suspended",
      ...overrides,
    };
  }

  /** Fake LifecycleTx capturing each executed statement's rendered SQL + params. */
  function fakeCancelTx(results: Array<{ rows: Array<{ id: string }> }>) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    let call = 0;
    const tx = {
      execute: async (query: unknown) => {
        const rendered = new PgDialect().sqlToQuery(query as SQL);
        executed.push({ sql: rendered.sql.toLowerCase(), params: rendered.params });
        const result = results[call] ?? { rows: [] };
        call += 1;
        return result;
      },
    };
    return { tx, executed };
  }

  async function runCancel(
    rec: AgentSandbox | undefined,
    results: Array<{ rows: Array<{ id: string }> }>,
  ) {
    const { spyTarget } = await makeCancelSvc();
    const lock = spyOn(spyTarget, "lockLifecycle").mockResolvedValue(undefined as never);
    const getRec = spyOn(spyTarget, "getAgentForLifecycleMutation").mockResolvedValue(rec);
    const { tx, executed } = fakeCancelTx(results);
    try {
      const outcome = await spyTarget.cancelAgentDeletionTx(
        tx,
        rec?.id ?? "missing-agent",
        rec?.organization_id ?? "org-x",
      );
      const lockCalls = lock.mock.calls.length;
      return { outcome, executed, lockCalls };
    } finally {
      lock.mockRestore();
      getRec.mockRestore();
    }
  }

  test("cancel-and-restore: queued job cancelled and the row returned to running, atomically", async () => {
    const rec = pendingDeletionSandbox();
    const { outcome, executed, lockCalls } = await runCancel(rec, [
      { rows: [] }, // no in_progress agent_delete job
      { rows: [] }, // pending-job cancellation
      { rows: [{ id: rec.id }] }, // row restore CAS
    ]);

    expect(outcome).toEqual({ success: true });
    expect(lockCalls).toBe(1);
    expect(executed).toHaveLength(3);
    // 1: only an in_progress agent_delete blocks cancellation.
    expect(executed[0]?.sql).toContain("'in_progress'");
    expect(executed[0]?.params).toContain("agent_delete");
    // 2: queued delete jobs are cancelled inside the same transaction.
    expect(executed[1]?.sql).toContain("status = 'cancelled'");
    expect(executed[1]?.sql).toContain("status = 'pending'");
    expect(executed[1]?.params).toContain("agent_delete");
    expect(executed[1]?.params).toContain(rec.id);
    // 3: the restore clears every deletion-intent column and reactivates billing,
    // CAS-guarded on the observed status + attempt id.
    const restore = executed[2];
    expect(restore?.params).toContain("running");
    expect(restore?.params).toContain("active");
    expect(restore?.sql).toContain("deletion_attempt_id = null");
    expect(restore?.sql).toContain("deletion_started_at = null");
    expect(restore?.sql).toContain("deletion_previous_status = null");
    expect(restore?.sql).toContain("deletion_previous_billing_status = null");
    expect(restore?.sql).toContain("deletion_previous_shutdown_warning_sent_at = null");
    expect(restore?.sql).toContain("deletion_previous_scheduled_shutdown_at = null");
    expect(restore?.sql).toContain("deletion_allocation_counted = null");
    expect(restore?.sql).toContain("status = 'deletion_pending'");
    expect(restore?.params).toContain(rec.deletion_attempt_id);
  });

  test("refuses while an agent_delete job is executing — teardown may already be running", async () => {
    const rec = pendingDeletionSandbox();
    const { outcome, executed } = await runCancel(rec, [{ rows: [{ id: "job-1" }] }]);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("already executing");
    // Nothing was cancelled and nothing was restored.
    expect(executed).toHaveLength(1);
  });

  test("refuses when the bridge is gone — no live workload for `running` to describe", async () => {
    const rec = pendingDeletionSandbox({ bridge_url: null });
    const { outcome, executed } = await runCancel(rec, []);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("no longer reachable");
    expect(executed).toHaveLength(0);
  });

  test("restores the captured billing warning and shutdown schedule instead of guessing healthy defaults", async () => {
    const warningSentAt = new Date("2026-08-13T10:00:00.000Z");
    const shutdownAt = new Date("2026-08-16T10:00:00.000Z");
    const rec = pendingDeletionSandbox({
      deletion_previous_billing_status: "warning",
      deletion_previous_shutdown_warning_sent_at: warningSentAt,
      deletion_previous_scheduled_shutdown_at: shutdownAt,
    });
    const { outcome, executed } = await runCancel(rec, [
      { rows: [] },
      { rows: [] },
      { rows: [{ id: rec.id }] },
    ]);

    expect(outcome).toEqual({ success: true });
    expect(executed[2]?.params).toContain("warning");
    expect(executed[2]?.params).toContain(warningSentAt);
    expect(executed[2]?.params).toContain(shutdownAt);
  });

  test("refuses legacy deletion rows that have no prior-state receipt", async () => {
    const rec = pendingDeletionSandbox({
      deletion_previous_status: null,
      deletion_previous_billing_status: null,
    });
    const { outcome, executed } = await runCancel(rec, []);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("reversible running-state receipt");
    expect(executed).toHaveLength(0);
  });

  test("refuses rows that are not deletion_pending (running and deletion_failed unchanged)", async () => {
    for (const status of ["running", "deletion_failed"] as const) {
      const rec = pendingDeletionSandbox({ status });
      const { outcome, executed } = await runCancel(rec, []);
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("not pending deletion");
      expect(executed).toHaveLength(0);
    }
  });

  test("missing rows refuse without touching jobs", async () => {
    const { outcome, executed } = await runCancel(undefined, []);
    expect(outcome).toEqual({ success: false, error: "Agent not found" });
    expect(executed).toHaveLength(0);
  });

  test("a concurrent ownership move fails the CAS instead of overwriting", async () => {
    const rec = pendingDeletionSandbox();
    const { outcome, executed } = await runCancel(rec, [
      { rows: [] },
      { rows: [] },
      { rows: [] }, // CAS matched nothing: attempt id / status moved underneath
    ]);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("ownership changed");
    expect(executed).toHaveLength(3);
  });
});
