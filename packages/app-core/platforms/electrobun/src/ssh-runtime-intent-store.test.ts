/** Verifies private, atomic, non-secret persistence for desired SSH tunnels. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SshRuntimeIntentStore,
  sshRuntimeIntentStoreInternals,
} from "./ssh-runtime-intent-store";

const roots: string[] = [];
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

async function createStore(): Promise<{
  store: SshRuntimeIntentStore;
  storePath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-ssh-intent-"));
  roots.push(root);
  const storePath = path.join(root, "ssh-runtime", "intents.json");
  return { store: new SshRuntimeIntentStore(storePath), storePath };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SSH runtime connection intent store", () => {
  it("round-trips only non-secret connection intent with private permissions", async () => {
    const { store, storePath } = await createStore();
    await store.upsert({
      runtimeId: "vps-main",
      target: "eliza@host.example",
      sshPort: 22,
      remoteApiPort: 31337,
      expectedFingerprint: FINGERPRINT,
      identityFile: "/home/eliza/.ssh/id_ed25519",
      credentialRef: "vps-main",
    });

    await expect(store.get("vps-main")).resolves.toMatchObject({
      target: "eliza@host.example",
      expectedFingerprint: FINGERPRINT,
    });
    const raw = await fs.readFile(storePath, "utf8");
    expect(raw).not.toContain("accessToken");
    expect(raw).not.toContain("privateKey");
    expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(storePath))).mode & 0o777).toBe(0o700);
  });

  it("serializes concurrent updates and makes deletion idempotent", async () => {
    const { store } = await createStore();
    await Promise.all(
      ["alpha", "beta", "gamma"].map((runtimeId) =>
        store.upsert({
          runtimeId,
          target: `eliza@${runtimeId}.example`,
          sshPort: 22,
          remoteApiPort: 31337,
          expectedFingerprint: FINGERPRINT,
          credentialRef: runtimeId,
        }),
      ),
    );

    await expect(store.list()).resolves.toHaveLength(3);
    await expect(store.delete("beta")).resolves.toBe(true);
    await expect(store.delete("beta")).resolves.toBe(false);
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ runtimeId: "alpha" }),
      expect.objectContaining({ runtimeId: "gamma" }),
    ]);
  });

  it("persists revocation so a fresh process cannot resurrect the tunnel", async () => {
    const { store, storePath } = await createStore();
    await store.upsert({
      runtimeId: "revoked-vps",
      target: "eliza@revoked.example",
      sshPort: 22,
      remoteApiPort: 31337,
      expectedFingerprint: FINGERPRINT,
      credentialRef: "revoked-vps",
    });
    await expect(store.delete("revoked-vps")).resolves.toBe(true);
    await expect(store.delete("revoked-vps")).resolves.toBe(false);

    const afterRestart = new SshRuntimeIntentStore(storePath);
    await expect(afterRestart.list()).resolves.toEqual([]);
  });

  it("fails closed on corrupt or secret-shaped durable state", () => {
    expect(() =>
      sshRuntimeIntentStoreInternals.parseStore(
        JSON.stringify({
          version: 1,
          intents: [
            {
              runtimeId: "vps",
              target: "eliza@host.example",
              sshPort: 22,
              remoteApiPort: 31337,
              expectedFingerprint: FINGERPRINT,
              accessToken: "must-not-be-accepted",
            },
          ],
        }),
      ),
    ).toThrow("corrupt");
    expect(() =>
      sshRuntimeIntentStoreInternals.parseStore(
        JSON.stringify({
          version: 1,
          intents: [
            {
              runtimeId: "vps",
              target: "eliza@host.example",
              sshPort: 22,
              remoteApiPort: 31337,
              expectedFingerprint: FINGERPRINT,
              credentialRef: "different-runtime",
            },
          ],
        }),
      ),
    ).toThrow("corrupt");
    expect(() =>
      sshRuntimeIntentStoreInternals.parseStore(
        JSON.stringify({ version: 1, intents: [{ runtimeId: "../../bad" }] }),
      ),
    ).toThrow("corrupt");
  });
});
