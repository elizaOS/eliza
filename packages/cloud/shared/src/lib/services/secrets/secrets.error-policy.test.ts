/**
 * Error-policy proof for the secrets bulk-create boundary (#13415). Drives the
 * real SecretsService with real AES encryption (fake in-memory KMS) and a
 * mocked repository so the changed catch is exercised for real: a systemic
 * repository failure must PROPAGATE (fail closed), while a per-item
 * encrypt/size-validation failure is captured as a structured errors[] entry —
 * the two outcomes are distinguishable, never conflated into an all-errors batch.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

const secretsRepository = {
  findByName: mock(),
  create: mock(),
};
const secretAuditLogRepository = {
  create: mock(),
};

// Mock the repository barrel that SecretsService imports from. The barrel also
// exports bindings/oauth/app-requirement repositories that the service module
// pulls in at import time, so they must be present (unused here).
mock.module("../../../db/repositories/secrets", () => ({
  secretsRepository,
  secretAuditLogRepository,
  secretBindingsRepository: {},
  oauthSessionsRepository: {},
  appSecretRequirementsRepository: {},
}));

import { createEncryptionService, type KMSProvider } from "./encryption";
import { SecretsService } from "./secrets";

const fakeKms: KMSProvider = {
  async generateDataKey() {
    return { plaintext: Buffer.alloc(32, 7), ciphertext: "fake-dek", keyId: "test-key" };
  },
  async decrypt() {
    return Buffer.alloc(32, 7);
  },
  isConfigured: () => true,
};

const audit = { actorType: "system", actorId: "test", source: "test" } as const;

function makeSecretRow(name: string) {
  return {
    id: `id-${name}`,
    organization_id: "org1",
    name,
    description: null,
    scope: "organization",
    project_id: null,
    project_type: null,
    environment: null,
    provider: null,
    provider_metadata: null,
    encrypted_value: "x",
    encryption_key_id: "test-key",
    encrypted_dek: "d",
    nonce: "n",
    auth_tag: "t",
    version: 1,
    expires_at: null,
    last_rotated_at: null,
    last_accessed_at: null,
    access_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function newService() {
  return new SecretsService(createEncryptionService(fakeKms));
}

describe("SecretsService.bulkCreate error policy", () => {
  beforeEach(() => {
    secretsRepository.findByName.mockReset();
    secretsRepository.create.mockReset();
    secretAuditLogRepository.create.mockReset();
  });

  it("propagates a systemic repository failure (fail closed, not swallowed into errors[])", async () => {
    secretsRepository.findByName.mockResolvedValue(undefined);
    secretsRepository.create.mockRejectedValue(new Error("db down"));
    secretAuditLogRepository.create.mockResolvedValue(undefined);

    const svc = newService();

    // A repository outage is a broken pipeline, not a per-item validation
    // failure: it must throw out of bulkCreate rather than be reported as a
    // structured errors[] entry that masks the outage.
    await expect(
      svc.bulkCreate(
        {
          organizationId: "org1",
          secrets: [{ name: "A", value: "value" }],
          createdBy: "u1",
        },
        audit,
      ),
    ).rejects.toThrow("db down");
  });

  it("captures a per-item size-validation failure as a structured errors[] entry while still creating the valid item", async () => {
    secretsRepository.findByName.mockResolvedValue(undefined);
    secretsRepository.create.mockImplementation((row: { name: string }) =>
      Promise.resolve(makeSecretRow(row.name)),
    );
    secretAuditLogRepository.create.mockResolvedValue(undefined);

    const svc = newService();

    const oversized = "a".repeat(65_537); // > MAX_SECRET_VALUE_BYTES (64KB)
    const result = await svc.bulkCreate(
      {
        organizationId: "org1",
        secrets: [
          { name: "TOO_BIG", value: oversized },
          { name: "OK", value: "small" },
        ],
        createdBy: "u1",
      },
      audit,
    );

    // Designed partial-success shape: the invalid item is an explicit error,
    // the valid item is created — the failure did not abort the batch nor
    // fabricate a created entry for the invalid input.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("TOO_BIG");
    expect(result.errors[0].error).toMatch(/maximum size/i);

    expect(result.created).toHaveLength(1);
    expect(result.created[0].name).toBe("OK");

    // The oversized item never reached the writer.
    expect(secretsRepository.create).toHaveBeenCalledTimes(1);
    expect(secretsRepository.create).toHaveBeenCalledWith(expect.objectContaining({ name: "OK" }));
  });
});
