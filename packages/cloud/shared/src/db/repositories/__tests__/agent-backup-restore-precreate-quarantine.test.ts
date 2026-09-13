/**
 * Clause isolation for `hasExactAgentBackupRestorePrecreateQuarantine`, the
 * gate that must hold before restore vault material leaves KMS authority
 * (`bindAgentBackupVaultKeyGeneration`). Every term is asserted on its own so
 * that removing any one of them fails here: the PGlite suites detect a fully
 * inverted predicate but no single dropped clause, because their fixtures only
 * ever present rows that satisfy all of them at once.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSandbox } from "../../schemas/agent-sandboxes";
import { hasExactAgentBackupRestorePrecreateQuarantine } from "../agent-backup-restore-history";

const RESTORE_ATTEMPT_ID = "rsa_01JQUARANTINE0000000000000";
const BACKUP_ID = "bk_01JQUARANTINE0000000000000";
const MANIFEST_SHA256 = `sha256:${"a".repeat(64)}`;
const ACTIVATION_TOKEN_SHA256 = `sha256:${"b".repeat(64)}`;
const MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES = 16_384;

/** A row that satisfies every clause: a pristine container_pending quarantine. */
function quarantinedSandbox(overrides: Partial<AgentSandbox> = {}): Readonly<AgentSandbox> {
  return {
    deleted_at: null,
    lifecycle_revision: 7,
    activation_generation: RESTORE_ATTEMPT_ID,
    activation_lifecycle_revision: 7n,
    activation_purpose: "restore",
    activation_backup_id: BACKUP_ID,
    activation_backup_hash: MANIFEST_SHA256,
    activation_token_hash: ACTIVATION_TOKEN_SHA256,
    activation_token_ciphertext: "ciphertext",
    activation_consent_lifecycle_revision: null,
    activation_consent_head_backup_id: null,
    activation_consent_head_backup_hash: null,
    activation_phase: "container_pending",
    activation_receipt: null,
    activation_receipt_hash: null,
    activation_container_id: null,
    activation_node_id: null,
    activation_image_digest: null,
    activation_boot_id: null,
    activation_authority_published_at: null,
    activation_funding_revision: null,
    activation_dispatched_at: null,
    activation_completed_at: null,
    ...overrides,
  } as unknown as AgentSandbox;
}

function check(overrides: Partial<AgentSandbox> = {}): boolean {
  return hasExactAgentBackupRestorePrecreateQuarantine({
    sandbox: quarantinedSandbox(overrides),
    restoreAttemptId: RESTORE_ATTEMPT_ID,
    backupId: BACKUP_ID,
    manifestSha256: MANIFEST_SHA256,
    expectedActivationTokenSha256: ACTIVATION_TOKEN_SHA256,
  });
}

describe("hasExactAgentBackupRestorePrecreateQuarantine clause isolation", () => {
  test("admits a pristine container-pending restore quarantine", () => {
    expect(check()).toBe(true);
  });

  // Binding identity: the row must be the one this restore attempt owns.
  const identityCases = [
    ["the sandbox is soft-deleted", { deleted_at: new Date() }],
    ["another attempt owns the activation", { activation_generation: "rsa_other" }],
    [
      "the activation is not pinned to a lifecycle revision",
      { activation_lifecycle_revision: null },
    ],
    ["the pinned revision has drifted from the row", { activation_lifecycle_revision: 8n }],
    ["the activation is not a restore", { activation_purpose: "provision" }],
    ["a different backup is staged", { activation_backup_id: "bk_other" }],
    ["the manifest hash disagrees", { activation_backup_hash: `sha256:${"c".repeat(64)}` }],
    ["the activation token hash disagrees", { activation_token_hash: `sha256:${"d".repeat(64)}` }],
  ] as const;

  // Token ciphertext: present, non-empty, bounded, and free of NUL.
  const ciphertextCases = [
    ["the ciphertext is absent", { activation_token_ciphertext: null }],
    ["the ciphertext is not a string", { activation_token_ciphertext: 42 }],
    ["the ciphertext is empty", { activation_token_ciphertext: "" }],
    [
      "the ciphertext exceeds the byte bound",
      {
        activation_token_ciphertext: "x".repeat(MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES + 1),
      },
    ],
    [
      "the ciphertext carries a NUL",
      { activation_token_ciphertext: "cipher" + String.fromCharCode(0) + "text" },
    ],
  ] as const;

  // Consent columns belong to a different activation path and must be unset.
  const consentCases = [
    ["a consent lifecycle revision is recorded", { activation_consent_lifecycle_revision: 7n }],
    ["a consent head backup id is recorded", { activation_consent_head_backup_id: BACKUP_ID }],
    [
      "a consent head backup hash is recorded",
      { activation_consent_head_backup_hash: MANIFEST_SHA256 },
    ],
  ] as const;

  // Precreate exactness: nothing downstream of container creation may exist yet.
  const precreateCases = [
    ["the activation has left container_pending", { activation_phase: "container_created" }],
    ["a receipt was already recorded", { activation_receipt: "receipt" }],
    [
      "a receipt hash was already recorded",
      { activation_receipt_hash: `sha256:${"e".repeat(64)}` },
    ],
    ["a container already exists", { activation_container_id: "container-1" }],
    ["a node is already bound", { activation_node_id: "node-1" }],
    ["an image digest is already pinned", { activation_image_digest: `sha256:${"f".repeat(64)}` }],
    ["a boot id is already recorded", { activation_boot_id: "boot-1" }],
    ["authority was already published", { activation_authority_published_at: new Date() }],
    ["a funding revision is already bound", { activation_funding_revision: 3n }],
    ["the activation was already dispatched", { activation_dispatched_at: new Date() }],
    ["the activation already completed", { activation_completed_at: new Date() }],
  ] as const;

  test.each([...identityCases, ...ciphertextCases, ...consentCases, ...precreateCases])(
    "refuses quarantine when %s",
    (_name, overrides) => {
      expect(check(overrides as Partial<AgentSandbox>)).toBe(false);
    },
  );

  test("accepts a ciphertext exactly at the byte bound", () => {
    // The bound is inclusive; pinned from both sides so tightening it to `<`
    // becomes a deliberate change rather than an accident.
    expect(
      check({
        activation_token_ciphertext: "x".repeat(MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES),
      } as Partial<AgentSandbox>),
    ).toBe(true);
  });

  test("counts the ciphertext bound in UTF-8 bytes, not code units", () => {
    // `Buffer.byteLength(..., "utf8")` — a two-byte character repeated to the
    // code-unit bound is already over the byte bound.
    expect(
      check({
        activation_token_ciphertext: "\u00e9".repeat(MAX_ACTIVATION_TOKEN_CIPHERTEXT_BYTES),
      } as Partial<AgentSandbox>),
    ).toBe(false);
  });
});
