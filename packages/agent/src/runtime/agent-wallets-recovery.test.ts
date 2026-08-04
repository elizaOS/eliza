/**
 * Verifies per-agent wallet bootstrap recovers from real authenticated-vault
 * decryption failure by preserving opaque rows and generating replacements.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  generateMasterKey,
  inMemoryMasterKey,
  PgliteVaultImpl,
} from "@elizaos/vault";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgentWallets, setAgentWallet } from "./agent-wallets.ts";

const openedVaults: PgliteVaultImpl[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const vault of openedVaults.splice(0)) await vault.close();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("agent wallet bootstrap recovery", () => {
  it("quarantines wrong-key ciphertext and creates usable replacement wallets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-wallet-recovery-"));
    tempDirs.push(dir);
    const dataDir = join(dir, ".vault-pglite");
    const auditPath = join(dir, "audit", "vault.jsonl");
    const originalKey = generateMasterKey();
    const writer = new PgliteVaultImpl({
      dataDir,
      auditPath,
      masterKey: inMemoryMasterKey(originalKey),
    });
    openedVaults.push(writer);
    await setAgentWallet(
      writer,
      "eliza",
      "evm",
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      "0x0000000000000000000000000000000000000001",
      "test-seed",
    );
    await setAgentWallet(
      writer,
      "eliza",
      "solana",
      "[1,2,3]",
      "OldSolanaAddress",
      "test-seed",
    );
    await writer.close();
    openedVaults.splice(openedVaults.indexOf(writer), 1);

    const reader = new PgliteVaultImpl({
      dataDir,
      auditPath,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
    openedVaults.push(reader);
    const replacements = await ensureAgentWallets(
      reader,
      "eliza",
      "test-bootstrap",
    );

    expect(replacements).toHaveLength(2);
    expect(replacements.map((wallet) => wallet.chain).sort()).toEqual([
      "evm",
      "solana",
    ]);
    expect(replacements.map((wallet) => wallet.address)).not.toContain(
      "0x0000000000000000000000000000000000000001",
    );
    expect(replacements.map((wallet) => wallet.address)).not.toContain(
      "OldSolanaAddress",
    );
    await reader.close();
    openedVaults.splice(openedVaults.indexOf(reader), 1);

    const db = await PGlite.create(dataDir);
    const quarantine = await db.query<{ original_key: string }>(
      `SELECT original_key FROM vault_quarantined_entries ORDER BY original_key`,
    );
    expect(quarantine.rows.map((row) => row.original_key)).toEqual([
      "agent.eliza.wallet.evm",
      "agent.eliza.wallet.solana",
    ]);
    await db.close();
  });
});
