/** Exercises refresh publication against real encrypted storage and CLI adoption; only provider HTTP is simulated. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vault from "../vault/crypto.js";
import {
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  listAccounts,
  loadAccount,
  saveAccount,
  touchAccount,
  updateAccountCredentialsIfUnchanged,
  updateAccountMetadata,
} from "./account-storage.ts";
import { getAccessToken, saveCredentials } from "./credentials.ts";
import { adoptCodexCliLogin } from "./subscription-auth/adopt-codex-cli-login.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auth-generation-"));
  roots.push(root);
  return {
    root,
    policy: createIsolatedAccountStoragePolicy(path.join(root, "store")),
  };
}
function token(label: string) {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, label, "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.synthetic`;
}
function holdRefresh() {
  let entered: () => void = () => {
    throw new Error("Dispatch gate not initialized");
  };
  let release: (response: Response) => void = () => {
    throw new Error("Response gate not initialized");
  };
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.stubGlobal("fetch", async () => {
    entered();
    return await new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  return {
    dispatched,
    release: (refreshToken?: string) =>
      release(
        new Response(
          JSON.stringify({
            access_token: token("late-refresh"),
            expires_in: 3600,
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  };
}
describe("credential publication ownership", () => {
  it("keeps an explicit same-refresh-token CLI adoption and returns its newer credential", async () => {
    const { root, policy } = setup();
    saveCredentials(
      "openai-codex",
      { access: "expired", refresh: "same-refresh", expires: 1 },
      "default",
      policy,
    );
    const gate = holdRefresh();
    const pending = getAccessToken("openai-codex", "default", {
      storagePolicy: policy,
      outcome: true,
    });
    await gate.dispatched;
    const codexHome = path.join(root, "cli");
    fs.mkdirSync(codexHome);
    const adopted = token("adopted");
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: { access_token: adopted, refresh_token: "same-refresh" },
      }),
      { mode: 0o600 },
    );
    adoptCodexCliLogin({
      storagePolicy: policy,
      accountId: "default",
      overwrite: true,
      codexHome,
    });
    gate.release();
    expect(await pending).toMatchObject({
      ok: true,
      accessToken: adopted,
      refreshed: false,
    });
    expect(
      loadAccount("openai-codex", "default", policy)?.credentials.access,
    ).toBe(adopted);
  });
  it("rejects stale publication after deletion and recreation with identical credential values", async () => {
    const { policy } = setup();
    saveCredentials(
      "openai-codex",
      { access: "expired", refresh: "same-refresh", expires: 1 },
      "default",
      policy,
    );
    const before = loadAccount("openai-codex", "default", policy);
    if (!before) throw new Error("Missing seeded record");
    const gate = holdRefresh();
    const pending = getAccessToken("openai-codex", "default", {
      storagePolicy: policy,
      outcome: true,
    });
    await gate.dispatched;
    deleteAccount("openai-codex", "default", policy);
    saveAccount(before, policy);
    gate.release();
    expect(await pending).toMatchObject({ ok: false });
    expect(loadAccount("openai-codex", "default", policy)?.credentials).toEqual(
      before.credentials,
    );
  });
  it("preserves a concurrent rename while publishing a rotated refresh grant", async () => {
    const { policy } = setup();
    const saved = saveCredentials(
      "openai-codex",
      { access: "expired", refresh: "old-refresh", expires: 1 },
      "default",
      policy,
    );
    const gate = holdRefresh();
    const pending = getAccessToken("openai-codex", "default", {
      storagePolicy: policy,
      outcome: true,
    });
    await gate.dispatched;
    expect(
      updateAccountMetadata(
        "openai-codex",
        "default",
        { label: "Renamed" },
        policy,
      ).kind,
    ).toBe("updated");
    expect(
      loadAccount("openai-codex", "default", policy)?.credentialGeneration,
    ).toBe(saved.credentialGeneration);
    gate.release("rotated-refresh");
    expect(await pending).toMatchObject({ ok: true, refreshed: true });
    expect(loadAccount("openai-codex", "default", policy)).toMatchObject({
      label: "Renamed",
      credentials: {
        refresh: "rotated-refresh",
        access: expect.stringContaining(".synthetic"),
      },
    });
  });
  it("does not resurrect a deleted account when a rename arrives", () => {
    const { policy } = setup();
    saveCredentials(
      "openai-codex",
      { access: "expired", refresh: "old-refresh", expires: 1 },
      "default",
      policy,
    );
    deleteAccount("openai-codex", "default", policy);
    expect(
      updateAccountMetadata(
        "openai-codex",
        "default",
        { label: "Renamed" },
        policy,
      ),
    ).toEqual({ kind: "missing" });
    expect(loadAccount("openai-codex", "default", policy)).toBeNull();
  });
  it("binds post-login profile metadata to the credential generation actually saved", () => {
    const { policy } = setup();
    const saved = saveCredentials(
      "openai-codex",
      { access: "first", refresh: "same-refresh", expires: 1 },
      "default",
      policy,
    );
    expect(
      updateAccountMetadata(
        "openai-codex",
        "default",
        { email: "first@example.invalid", label: "First" },
        policy,
        saved.credentialGeneration,
      ).kind,
    ).toBe("updated");
    saveCredentials(
      "openai-codex",
      { access: "second", refresh: "same-refresh", expires: 1 },
      "default",
      policy,
    );
    expect(
      updateAccountMetadata(
        "openai-codex",
        "default",
        { email: "stale@example.invalid", label: "Stale" },
        policy,
        saved.credentialGeneration,
      ).kind,
    ).toBe("changed");
    expect(loadAccount("openai-codex", "default", policy)).toMatchObject({
      email: "first@example.invalid",
      label: "First",
      credentials: { access: "second" },
    });
  });
  it("migrates legacy plaintext once and permits refresh after a usage-only touch", () => {
    const { root, policy } = setup();
    const directory = path.join(root, "store", "auth", "openai-codex");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "default.json");
    const record = {
      id: "default",
      providerId: "openai-codex",
      label: "legacy",
      source: "oauth",
      credentials: { access: "expired", refresh: "same-refresh", expires: 1 },
      createdAt: 1,
      updatedAt: 1,
    };
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    const listed = listAccounts("openai-codex", policy);
    const before = loadAccount("openai-codex", "default", policy);
    if (!before) throw new Error("Legacy record was not migrated");
    expect(listed[0]?.credentialGeneration).toBe(before.credentialGeneration);
    const encrypted = fs.readFileSync(file, "utf8");
    expect(encrypted).not.toContain("same-refresh");
    loadAccount("openai-codex", "default", policy);
    expect(fs.readFileSync(file, "utf8")).toBe(encrypted);
    touchAccount("openai-codex", "default", policy);
    const updated = updateAccountCredentialsIfUnchanged(
      "openai-codex",
      "default",
      before.credentialGeneration,
      {
        access: "fresh",
        refresh: "same-refresh",
        expires: Date.now() + 3600000,
      },
      policy,
    );
    expect(updated.kind).toBe("updated");
    expect(
      loadAccount("openai-codex", "default", policy)?.credentials.access,
    ).toBe("fresh");
    expect(
      updateAccountCredentialsIfUnchanged(
        "openai-codex",
        "default",
        before.credentialGeneration,
        { access: "late", refresh: "same-refresh", expires: 1 },
        policy,
      ).kind,
    ).toBe("changed");
  });
  it("migrates an encrypted legacy record without changing its credentials or envelope contract", () => {
    const { root, policy } = setup();
    // Observe the real isolated encryption call only to build an authentic old-format fixture.
    const encryption = vi.spyOn(vault, "encrypt");
    const saved = saveCredentials(
      "openai-codex",
      { access: "legacy-access", refresh: "legacy-refresh", expires: 1 },
      "default",
      policy,
    );
    const call = encryption.mock.calls.at(-1);
    if (!call) throw new Error("No encrypted write observed");
    const [key, , aad] = call;
    encryption.mockRestore();
    const { credentialGeneration: _generation, ...legacy } = saved;
    const file = path.join(
      root,
      "store",
      "auth",
      "openai-codex",
      "default.json",
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        ciphertext: vault.encrypt(key, JSON.stringify(legacy), aad),
      }),
      { mode: 0o600 },
    );
    const migrated = loadAccount("openai-codex", "default", policy);
    if (!migrated) throw new Error("Encrypted record was not migrated");
    expect(migrated.credentials).toEqual(legacy.credentials);
    const encrypted = fs.readFileSync(file, "utf8");
    const envelope = JSON.parse(encrypted);
    const decoded = JSON.parse(vault.decrypt(key, envelope.ciphertext, aad));
    expect(decoded).toEqual(migrated);
    expect(encrypted).not.toContain("legacy-refresh");
    loadAccount("openai-codex", "default", policy);
    expect(fs.readFileSync(file, "utf8")).toBe(encrypted);
    expect(
      updateAccountCredentialsIfUnchanged(
        "openai-codex",
        "default",
        migrated.credentialGeneration,
        { access: "fresh", refresh: "rotated", expires: 2 },
        policy,
      ).kind,
    ).toBe("updated");
  });
  it("treats an identical save as a replacement even when the caller echoes the old generation", () => {
    const { policy } = setup();
    saveCredentials(
      "openai-codex",
      { access: "expired", refresh: "same-refresh", expires: 1 },
      "default",
      policy,
    );
    const before = loadAccount("openai-codex", "default", policy);
    if (!before) throw new Error("Missing seeded record");
    saveAccount(before, policy);
    expect(
      updateAccountCredentialsIfUnchanged(
        "openai-codex",
        "default",
        before.credentialGeneration,
        { access: "late", refresh: "same-refresh", expires: 1 },
        policy,
      ).kind,
    ).toBe("changed");
    expect(loadAccount("openai-codex", "default", policy)?.credentials).toEqual(
      before.credentials,
    );
  });
});
