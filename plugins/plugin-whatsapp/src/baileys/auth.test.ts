/**
 * Exercises the real filesystem contract for connector-owned Baileys auth:
 * authority confinement, atomic snapshot recovery, restart, and logout.
 */
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { BufferJSON } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadDurableBaileysAuthState,
  removeDurableBaileysAuthState,
  resolveWhatsAppAuthDirectory,
  whatsappDurableAuthExists,
} from "./auth";

let testRoot: string;
let priorStateDir: string | undefined;

function expectAuthCode(code: string) {
  return expect.objectContaining({ name: "ElizaError", code });
}

beforeEach(async () => {
  priorStateDir = process.env.ELIZA_STATE_DIR;
  testRoot = await mkdtemp(path.join(tmpdir(), "whatsapp-auth-state-"));
  process.env.ELIZA_STATE_DIR = path.join(testRoot, "state");
});

afterEach(async () => {
  if (priorStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = priorStateDir;
  await rm(testRoot, { recursive: true, force: true });
});

describe("durable Baileys auth state", () => {
  it("round-trips credentials and keys across a restart in one snapshot", async () => {
    const first = await loadDurableBaileysAuthState("default");
    first.state.creds.registered = true;
    await first.state.keys.set({ "lid-mapping": { alice: "alice@lid" } });
    await first.saveCreds();

    const restarted = await loadDurableBaileysAuthState("default");
    expect(restarted.state.creds.registered).toBe(true);
    await expect(restarted.state.keys.get("lid-mapping", ["alice"])).resolves.toEqual({
      alice: "alice@lid",
    });
    expect(await readdir(first.authDir)).toEqual(
      expect.arrayContaining([".eliza-whatsapp-auth.json", "auth-state.json"])
    );
    expect((await readdir(first.authDir)).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("serializes concurrent key saves without dropping either update", async () => {
    const auth = await loadDurableBaileysAuthState("concurrent");
    await Promise.all([
      auth.state.keys.set({ "lid-mapping": { first: "one" } }),
      auth.state.keys.set({ "lid-mapping": { second: "two" } }),
      auth.saveCreds(),
    ]);
    const restarted = await loadDurableBaileysAuthState("concurrent");
    await expect(restarted.state.keys.get("lid-mapping", ["first", "second"])).resolves.toEqual({
      first: "one",
      second: "two",
    });
  });

  it("allows only the latest loaded state to own account writes", async () => {
    const first = await loadDurableBaileysAuthState("single-owner");
    const replacement = await loadDurableBaileysAuthState("single-owner");
    first.state.creds.registered = true;
    await expect(first.saveCreds()).rejects.toEqual(expectAuthCode("WHATSAPP_AUTH_STATE_RETIRED"));
    replacement.state.creds.registered = true;
    await replacement.saveCreds();
    const restarted = await loadDurableBaileysAuthState("single-owner");
    expect(restarted.state.creds.registered).toBe(true);
  });

  it("retires key reads after replacement and logout", async () => {
    const first = await loadDurableBaileysAuthState("stale-read");
    await first.state.keys.set({ "lid-mapping": { alice: "alice@lid" } });
    await loadDurableBaileysAuthState("stale-read");
    await expect(first.state.keys.get("lid-mapping", ["alice"])).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_STATE_RETIRED")
    );

    const logoutState = await loadDurableBaileysAuthState("stale-read-logout");
    await removeDurableBaileysAuthState("stale-read-logout");
    await expect(logoutState.state.keys.get("lid-mapping", ["alice"])).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_STATE_RETIRED")
    );
  });

  it("rejects broad or operator-selected auth directories", async () => {
    await expect(loadDurableBaileysAuthState("default", testRoot)).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_DIRECTORY_OUTSIDE_STATE_AUTHORITY")
    );
  });

  it("rejects foreign content and child symlinks", async () => {
    const authDir = resolveWhatsAppAuthDirectory("foreign");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "operator.txt"), "do not touch");
    await expect(loadDurableBaileysAuthState("foreign")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_FOREIGN_CONTENT")
    );

    await rm(path.join(authDir, "operator.txt"));
    await symlink(testRoot, path.join(authDir, "keys"));
    await expect(loadDurableBaileysAuthState("foreign")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_SYMLINK_REJECTED")
    );
  });

  it("rejects interrupted-looking content until ownership is proven", async () => {
    const authDir = resolveWhatsAppAuthDirectory("unowned-temp");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      path.join(authDir, ".auth-state.json.tmp-1-1-00000000-0000-4000-8000-000000000000"),
      "foreign"
    );
    await expect(loadDurableBaileysAuthState("unowned-temp")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_FOREIGN_CONTENT")
    );
  });

  it("checks auth status without claiming or cleaning an existing directory", async () => {
    const emptyDir = resolveWhatsAppAuthDirectory("status-empty");
    await mkdir(emptyDir, { recursive: true });
    await expect(whatsappDurableAuthExists("status-empty")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_FOREIGN_CONTENT")
    );
    expect(await readdir(emptyDir)).toEqual([]);

    const tempDir = resolveWhatsAppAuthDirectory("status-temp");
    await mkdir(tempDir, { recursive: true });
    const tempName = ".auth-state.json.tmp-1-1-00000000-0000-4000-8000-000000000000";
    await writeFile(path.join(tempDir, tempName), "operator bytes");
    await expect(whatsappDurableAuthExists("status-temp")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_FOREIGN_CONTENT")
    );
    expect(await readFile(path.join(tempDir, tempName), "utf8")).toBe("operator bytes");
  });

  it("rejects hard-linked connector metadata and snapshots", async () => {
    const ownerAuth = await loadDurableBaileysAuthState("hard-owner");
    await link(
      path.join(ownerAuth.authDir, ".eliza-whatsapp-auth.json"),
      path.join(testRoot, "owner-link")
    );
    await expect(loadDurableBaileysAuthState("hard-owner")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_HARDLINK_REJECTED")
    );

    const snapshotAuth = await loadDurableBaileysAuthState("hard-snapshot");
    await link(
      path.join(snapshotAuth.authDir, "auth-state.json"),
      path.join(testRoot, "state-link")
    );
    await expect(loadDurableBaileysAuthState("hard-snapshot")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_HARDLINK_REJECTED")
    );
  });

  it("does not chmod a preexisting operator directory", async () => {
    const authDir = resolveWhatsAppAuthDirectory("permissions");
    await mkdir(authDir, { recursive: true });
    await chmod(authDir, 0o750);
    await loadDurableBaileysAuthState("permissions");
    expect((await stat(authDir)).mode & 0o777).toBe(0o750);
    expect((await stat(path.join(authDir, "auth-state.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlinked state authority", async () => {
    const actual = path.join(testRoot, "actual");
    await mkdir(actual);
    const linked = path.join(testRoot, "linked");
    await symlink(actual, linked);
    process.env.ELIZA_STATE_DIR = linked;
    await expect(loadDurableBaileysAuthState("default")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_SYMLINK_REJECTED")
    );
  });

  it("fails closed on corrupt, unsupported, and mismatched committed snapshots", async () => {
    const auth = await loadDurableBaileysAuthState("broken");
    const snapshotPath = path.join(auth.authDir, "auth-state.json");
    await writeFile(snapshotPath, "{");
    await expect(loadDurableBaileysAuthState("broken")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_SNAPSHOT_CORRUPT")
    );

    const healthy = await loadDurableBaileysAuthState("versioned");
    const parsed = JSON.parse(
      await readFile(path.join(healthy.authDir, "auth-state.json"), "utf8"),
      BufferJSON.reviver
    );
    parsed.version = 99;
    await writeFile(
      path.join(healthy.authDir, "auth-state.json"),
      JSON.stringify(parsed, BufferJSON.replacer)
    );
    await expect(loadDurableBaileysAuthState("versioned")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_VERSION_UNSUPPORTED")
    );

    const mismatch = await loadDurableBaileysAuthState("mismatch");
    const mismatchPath = path.join(mismatch.authDir, "auth-state.json");
    const mismatched = JSON.parse(await readFile(mismatchPath, "utf8"), BufferJSON.reviver);
    mismatched.accountId = "other";
    await writeFile(mismatchPath, JSON.stringify(mismatched, BufferJSON.replacer));
    await expect(loadDurableBaileysAuthState("mismatch")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_SNAPSHOT_INVALID")
    );
  });

  it("rejects unknown top-level fields and malformed nested credentials and keys", async () => {
    const cases: Array<(snapshot: Record<string, unknown>) => void> = [
      (snapshot) => {
        snapshot.extra = true;
      },
      (snapshot) => {
        (snapshot.creds as Record<string, unknown>).noiseKey = { public: "not-bytes" };
      },
      (snapshot) => {
        (snapshot.keys as Record<string, unknown>)["unknown-key-type"] = {};
      },
      (snapshot) => {
        (snapshot.keys as Record<string, unknown>)["pre-key"] = {
          broken: { public: new Uint8Array([1]), private: "not-bytes" },
        };
      },
      (snapshot) => {
        (snapshot.keys as Record<string, unknown>)["app-state-sync-key"] = {
          broken: { keyData: new Uint8Array([1]), fingerprint: { deviceIndexes: [1, "bad"] } },
        };
      },
      (snapshot) => {
        (snapshot.keys as Record<string, unknown>)["app-state-sync-key"] = { broken: {} };
      },
      (snapshot) => {
        (snapshot.keys as Record<string, unknown>).tctoken = {
          broken: { token: new Uint8Array([1]), arbitrary: true },
        };
      },
    ];

    for (const [index, mutate] of cases.entries()) {
      const accountId = `malformed-${index}`;
      const auth = await loadDurableBaileysAuthState(accountId);
      const snapshotPath = path.join(auth.authDir, "auth-state.json");
      const snapshot = JSON.parse(
        await readFile(snapshotPath, "utf8"),
        BufferJSON.reviver
      ) as Record<string, unknown>;
      mutate(snapshot);
      await writeFile(snapshotPath, JSON.stringify(snapshot, BufferJSON.replacer));
      await expect(loadDurableBaileysAuthState(accountId)).rejects.toEqual(
        expectAuthCode("WHATSAPP_AUTH_SNAPSHOT_INVALID")
      );
    }
  });

  it("discards an interrupted temp snapshot and retains the last committed state", async () => {
    const auth = await loadDurableBaileysAuthState("partial");
    auth.state.creds.registered = true;
    await auth.saveCreds();
    await writeFile(
      path.join(auth.authDir, ".auth-state.json.tmp-1-1-00000000-0000-4000-8000-000000000000"),
      "partial"
    );

    const restarted = await loadDurableBaileysAuthState("partial");
    expect(restarted.state.creds.registered).toBe(true);
    expect(await readdir(auth.authDir)).not.toContain(
      ".auth-state.json.tmp-1-1-00000000-0000-4000-8000-000000000000"
    );
  });

  it("surfaces post-rename durability failures as an ambiguous commit", async () => {
    let injectFailure = false;
    const auth = await loadDurableBaileysAuthState("ambiguous", undefined, {
      afterRename: async (filename) => {
        if (injectFailure && filename === "auth-state.json")
          throw new Error("injected dir fsync failure");
      },
    });
    injectFailure = true;
    auth.state.creds.registered = true;
    await expect(auth.saveCreds()).rejects.toEqual(
      expect.objectContaining({
        name: "ElizaError",
        code: "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
        context: expect.objectContaining({ phase: "snapshot" }),
      })
    );
    const committed = JSON.parse(
      await readFile(path.join(auth.authDir, "auth-state.json"), "utf8"),
      BufferJSON.reviver
    );
    expect(committed.creds.registered).toBe(true);
    await expect(auth.state.keys.get("lid-mapping", ["alice"])).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_STATE_RETIRED")
    );
    injectFailure = false;
    await expect(loadDurableBaileysAuthState("ambiguous")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED")
    );
  });

  it("keeps memory and the committed snapshot unchanged after a pre-rename key failure", async () => {
    let injectFailure = false;
    const auth = await loadDurableBaileysAuthState("staged-key-failure", undefined, {
      beforeRename: async (filename) => {
        if (injectFailure && filename === "auth-state.json")
          throw new Error("injected rename failure");
      },
    });
    const snapshotPath = path.join(auth.authDir, "auth-state.json");
    const before = await readFile(snapshotPath, "utf8");
    injectFailure = true;
    await expect(auth.state.keys.set({ "lid-mapping": { alice: "alice@lid" } })).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_ATOMIC_WRITE_FAILED")
    );
    await expect(auth.state.keys.get("lid-mapping", ["alice"])).resolves.toEqual({
      alice: undefined,
    });
    expect(await readFile(snapshotPath, "utf8")).toBe(before);
    injectFailure = false;
    const restarted = await loadDurableBaileysAuthState("staged-key-failure");
    await expect(restarted.state.keys.get("lid-mapping", ["alice"])).resolves.toEqual({
      alice: undefined,
    });
  });

  it.each([
    ["beforeRename", false],
    ["afterRename", true],
  ] as const)(
    "retires after commit confirmation %s failure and exposes the exact restart state",
    async (hookName, confirmedVisible) => {
      let injectFailure = false;
      const hook = async (_filename: string, phase: string) => {
        if (injectFailure && phase === "commit-confirmed")
          throw new Error("injected confirm failure");
      };
      const auth = await loadDurableBaileysAuthState("confirm-failure", undefined, {
        [hookName]: hook,
      });
      injectFailure = true;
      await expect(
        auth.state.keys.set({ "lid-mapping": { alice: "alice@lid" } })
      ).rejects.toMatchObject({
        code: "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
        context: expect.objectContaining({ phase: "commit-confirmed" }),
      });
      await expect(auth.state.keys.get("lid-mapping", ["alice"])).rejects.toEqual(
        expectAuthCode("WHATSAPP_AUTH_STATE_RETIRED")
      );
      injectFailure = false;
      if (!confirmedVisible) {
        await expect(loadDurableBaileysAuthState("confirm-failure")).rejects.toEqual(
          expectAuthCode("WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED")
        );
      } else {
        const restarted = await loadDurableBaileysAuthState("confirm-failure");
        await expect(restarted.state.keys.get("lid-mapping", ["alice"])).resolves.toEqual({
          alice: "alice@lid",
        });
      }
    }
  );

  it("preserves a pre-rename typed failure when temporary cleanup also fails", async () => {
    let injectFailure = false;
    const auth = await loadDurableBaileysAuthState("cleanup-failure", undefined, {
      beforeRename: async (filename) => {
        if (injectFailure && filename === "auth-state.json")
          throw new Error("injected rename failure");
      },
      beforeTempCleanup: async (filename) => {
        if (injectFailure && filename === "auth-state.json")
          throw new Error("injected cleanup failure");
      },
    });
    injectFailure = true;
    await expect(auth.saveCreds()).rejects.toMatchObject({
      code: "WHATSAPP_AUTH_ATOMIC_WRITE_FAILED",
      context: expect.objectContaining({ commitState: "unchanged" }),
    });
    expect(
      (await readdir(auth.authDir)).some((name) => name.startsWith(".auth-state.json.tmp-"))
    ).toBe(true);
    await expect(auth.state.keys.get("lid-mapping", ["alice"])).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_STATE_RETIRED")
    );
  });

  it("rejects account ownership collisions", async () => {
    const auth = await loadDurableBaileysAuthState("owned");
    await writeFile(
      path.join(auth.authDir, ".eliza-whatsapp-auth.json"),
      JSON.stringify({ version: 1, accountId: "different" })
    );
    await expect(loadDurableBaileysAuthState("owned")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_ACCOUNT_COLLISION")
    );
  });

  it("logout removes only the dedicated account directory", async () => {
    await loadDurableBaileysAuthState("logout");
    const sibling = await loadDurableBaileysAuthState("sibling");
    expect(await whatsappDurableAuthExists("logout")).toBe(true);
    await removeDurableBaileysAuthState("logout");
    expect(await whatsappDurableAuthExists("logout")).toBe(false);
    expect(await whatsappDurableAuthExists("sibling")).toBe(true);
    expect(sibling.authDir).toBe(resolveWhatsAppAuthDirectory("sibling"));
  });

  it("deletes an owned corrupt snapshot but never claims an unowned directory", async () => {
    const corrupt = await loadDurableBaileysAuthState("logout-corrupt");
    await writeFile(path.join(corrupt.authDir, "auth-state.json"), "{");
    await removeDurableBaileysAuthState("logout-corrupt");
    await expect(lstat(path.join(corrupt.authDir))).rejects.toMatchObject({ code: "ENOENT" });

    const unowned = resolveWhatsAppAuthDirectory("logout-unowned");
    await mkdir(unowned, { recursive: true });
    await expect(removeDurableBaileysAuthState("logout-unowned")).rejects.toEqual(
      expectAuthCode("WHATSAPP_AUTH_OWNER_MISSING")
    );
    expect(await readdir(unowned)).toEqual([]);
  });

  it("retires saves queued while logout is paused and never recreates the account", async () => {
    const auth = await loadDurableBaileysAuthState("logout-race");
    let releaseDelete!: () => void;
    let enteredDelete!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredDelete = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const logout = removeDurableBaileysAuthState("logout-race", {
      beforeLogoutDelete: async () => {
        enteredDelete();
        await release;
      },
    });
    await entered;
    auth.state.creds.registered = true;
    const staleSave = auth.saveCreds();
    releaseDelete();
    await logout;
    await expect(staleSave).rejects.toEqual(expectAuthCode("WHATSAPP_AUTH_STATE_RETIRED"));
    expect(await whatsappDurableAuthExists("logout-race")).toBe(false);
  });

  it("uses typed errors without exposing credential material", async () => {
    await expect(loadDurableBaileysAuthState("../secret")).rejects.toBeInstanceOf(ElizaError);
    await expect(loadDurableBaileysAuthState("../secret")).rejects.not.toHaveProperty(
      "context.rawKeyMaterial"
    );
  });
});
