/** Exact runtime/vault authority tests for the production capture resolver. */

import { describe, expect, mock, test } from "bun:test";
import { createAgentBackupCaptureV3RuntimeContextResolver } from "./agent-backup-capture-v3-runtime-context";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVATION_GENERATION = "33333333-3333-4333-8333-333333333333";
const NODE_RECORD_ID = "44444444-4444-4444-8444-444444444444";
const NODE_INCARCERATION = "55555555-5555-4555-8555-555555555555";
const VAULT_GENERATION = "66666666-6666-4666-8666-666666666666";
const source = {
  kind: "robot" as const,
  provider: "hetzner" as const,
  nodeRecordId: NODE_RECORD_ID,
  nodeId: "robot-01",
  nodeIncarnation: NODE_INCARCERATION,
  containerId: "a".repeat(64),
};

function authority() {
  return {
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "7",
    status: "running",
    activationPhase: "active",
    source,
    imageDigest: `sha256:${"b".repeat(64)}`,
    providerHandle: "agent-provider-handle",
    bridgeUrl: "https://agent.example.test/",
    bridgePort: null,
    headscaleIp: null,
    nodeHostname: "robot-01.example.test",
    environmentVars: { ELIZA_API_TOKEN: "stored-token" },
  };
}

function vault(generationId = VAULT_GENERATION) {
  return {
    vaultKeyAuthority: {
      format: "kms-aead-vault-passphrase-v1" as const,
      generationId,
      receiptDerivation: "elizaos.agent-vault-key.authority-receipt.v1" as const,
      receiptDigest: "c".repeat(64),
    },
    kms: {
      provider: "steward" as const,
      keyId: `org:${ORGANIZATION_ID}/dek/v1`,
      keyVersion: 1,
    },
  };
}

function resolver(overrides: Record<string, unknown> = {}) {
  return createAgentBackupCaptureV3RuntimeContextResolver(
    {
      spool: {
        stateDirectory: "/var/lib/eliza-backup-catalog/spool",
        maxSpoolBytes: 1024 ** 3,
        minFreeBytes: 1024,
      },
      keyBundle: { kind: "shared-key-bundle" } as never,
      runtime: {
        agentSchemaVersion: "2.0.0",
        databaseSchemaVersion: "238",
        plugins: [{ id: "@elizaos/plugin-sql", version: "2.0.0" }],
      },
    },
    {
      loadAuthority: mock(async () => authority()),
      loadVaultAuthority: mock(async () => vault()),
      decryptEnvironmentVars: mock(async () => ({ ELIZA_API_TOKEN: "api-token" })),
      authorizePublicUrl: mock(async (value: string) => new URL(value)),
      ...overrides,
    } as never,
  );
}

function input(expectedSource = source) {
  return {
    claim: { backup: {} } as never,
    request: {} as never,
    expectedSource,
    heartbeat: mock(async () => true as const),
    signal: new AbortController().signal,
  };
}

describe("manifest-v3 production runtime context", () => {
  test("binds exact DB source/runtime, shared spool/KMS and authenticated route", async () => {
    const resolve = resolver();
    const context = await resolve(input());
    expect(context.attestation).toMatchObject({
      organizationId: ORGANIZATION_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "7",
      source,
      runtime: {
        imageDigest: `sha256:${"b".repeat(64)}`,
        agentSchemaVersion: "2.0.0",
        databaseSchemaVersion: "238",
      },
      watermarks: [{ namespace: "control-plane.lifecycle-revision", value: "7" }],
    });
    expect(context.transport).toMatchObject({
      agentApiBaseUrl: "https://agent.example.test/",
      apiToken: "api-token",
    });
    expect(context.kms).toEqual(vault().kms);
    expect(context.vaultKeyAuthority).toEqual(vault().vaultKeyAuthority);
    expect(await context.revalidateAttestation()).toEqual(context.attestation);
  });

  test("rejects database authority that differs from the reserved source", async () => {
    const resolve = resolver();
    await expect(
      resolve(
        input({
          ...source,
          nodeId: "other-node",
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_MISMATCH" });
  });

  test("fails revalidation when the current vault generation rotates", async () => {
    let reads = 0;
    const resolve = resolver({
      loadVaultAuthority: mock(async () => vault(++reads === 1 ? VAULT_GENERATION : AGENT_ID)),
    });
    const context = await resolve(input());
    await expect(context.revalidateAttestation()).rejects.toMatchObject({
      code: "AGENT_BACKUP_V3_VAULT_AUTHORITY_CHANGED",
    });
  });

  test("propagates caller cancellation before any authority read", async () => {
    const loadAuthority = mock(async () => authority());
    const resolve = resolver({ loadAuthority });
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    await expect(resolve({ ...input(), signal: controller.signal })).rejects.toThrow("shutdown");
    expect(loadAuthority).not.toHaveBeenCalled();
  });
});
