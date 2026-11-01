/**
 * A stored agent-vault import session that cannot be decrypted must not read as
 * "no session". POST /vault/:agentId/import/submit turns an absent session into
 * a 400 "Encrypted import session is invalid or expired" client error, so a
 * key-store rotation or a torn write currently looks like the client sent a
 * stale id and the real server fault is never reported.
 */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

test("reports an unreadable stored vault import session", async () => {
  const previous = process.env.STEWARD_MASTER_PASSWORD;
  process.env.STEWARD_MASTER_PASSWORD = randomBytes(32).toString("hex");
  try {
    const { encryptImportSessionJson } = await import(
      "../api/services/auth-lifecycle"
    );
    const {
      parseStoredEncryptedImportSession,
      VaultEncryptedImportSessionUnreadableError,
    } = await import("../api/routes/vault");

    const session = {
      id: "wimp_test",
      tenantId: "tenant_test",
      agentId: "agent_test",
      chain: "evm" as const,
      createdBy: null,
      privateKey: "sealed-private-key",
      publicKey: "sealed-public-key",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_600_000,
    };

    // A record that is present and decrypts still parses.
    expect(
      parseStoredEncryptedImportSession(encryptImportSessionJson(session)),
    ).toEqual(session);

    // No record at all is a legitimate absence.
    expect(parseStoredEncryptedImportSession(null)).toBeNull();

    // Simulate a key-store rotation or a torn write: the bytes are present but
    // no longer decrypt. That is a server fault, not a missing session.
    const unreadable = "v1:not-a-sealed-record";
    let thrown: unknown;
    try {
      parseStoredEncryptedImportSession(unreadable);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VaultEncryptedImportSessionUnreadableError);
    // A bare SyntaxError would be rewritten to 400 "Invalid JSON" at the HTTP
    // boundary, so the wrapper has to be its own type.
    expect(thrown).not.toBeInstanceOf(SyntaxError);
  } finally {
    if (previous === undefined) delete process.env.STEWARD_MASTER_PASSWORD;
    else process.env.STEWARD_MASTER_PASSWORD = previous;
  }
});
