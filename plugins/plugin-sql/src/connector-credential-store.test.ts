import { describe, expect, it, vi } from "vitest";
import {
  buildConnectorCredentialVaultRef,
  createConnectorCredentialStore,
} from "./connector-credential-store";

const baseParams = {
  agentId: "a1b2c3",
  provider: "gmail",
  accountId: "acc-1",
  credentialType: "oauth",
} as const;

describe("buildConnectorCredentialVaultRef", () => {
  it("joins normalized segments with dots", () => {
    expect(buildConnectorCredentialVaultRef(baseParams)).toBe("connector.a1b2c3.gmail.acc-1.oauth");
  });

  it("slugifies whitespace and non-alphanumeric characters per segment", () => {
    expect(
      buildConnectorCredentialVaultRef({
        agentId: "agent id",
        provider: "gmail/oauth",
        accountId: "acc!1",
        credentialType: "type",
      })
    ).toBe("connector.agent_id.gmail_oauth.acc_1.type");
  });

  it("trims leading and trailing underscores from segments", () => {
    expect(
      buildConnectorCredentialVaultRef({
        agentId: "_agent_",
        provider: "gmail",
        accountId: "acc",
        credentialType: "oauth",
      })
    ).toBe("connector.agent.gmail.acc.oauth");
  });

  it("falls back to 'unknown' for empty segments", () => {
    expect(
      buildConnectorCredentialVaultRef({
        agentId: "   ",
        provider: "gmail",
        accountId: "acc",
        credentialType: "oauth",
      })
    ).toBe("connector.unknown.gmail.acc.oauth");
  });

  it("caps each normalized segment at 64 characters", () => {
    const long = "x".repeat(100);
    const ref = buildConnectorCredentialVaultRef({
      agentId: long,
      provider: "gmail",
      accountId: "acc",
      credentialType: "oauth",
    });
    expect(ref.split(".")[1]).toBe("x".repeat(64));
  });
});

describe("createConnectorCredentialStore", () => {
  it("putSecret stores with sensitive flag and returns the built ref", async () => {
    const set = vi.fn(async () => {});
    const store = createConnectorCredentialStore({
      set,
      get: vi.fn(),
      has: vi.fn(),
      remove: vi.fn(),
    });
    const ref = await store.putSecret({ ...baseParams, value: "s3cret" });
    expect(ref).toBe("connector.a1b2c3.gmail.acc-1.oauth");
    expect(set).toHaveBeenCalledWith(ref, "s3cret", { sensitive: true });
  });

  it("putSecret forwards caller and honors an explicit vaultRef", async () => {
    const set = vi.fn(async () => {});
    const store = createConnectorCredentialStore({
      set,
      get: vi.fn(),
      has: vi.fn(),
      remove: vi.fn(),
    });
    const ref = await store.putSecret({
      vaultRef: "custom.ref",
      ...baseParams,
      value: "v",
      caller: "lifeops",
    });
    expect(ref).toBe("custom.ref");
    expect(set).toHaveBeenCalledWith("custom.ref", "v", {
      sensitive: true,
      caller: "lifeops",
    });
  });

  it("putReference rejects when the vault does not support references", async () => {
    const store = createConnectorCredentialStore({
      set: vi.fn(),
      get: vi.fn(),
      has: vi.fn(),
      remove: vi.fn(),
    });
    await expect(
      store.putReference({
        ...baseParams,
        reference: { source: "1password", path: "Vault/Item" },
      })
    ).rejects.toThrow("does not support password-manager references");
  });

  it("putReference delegates to vault.setReference and returns the ref", async () => {
    const setReference = vi.fn(async () => {});
    const store = createConnectorCredentialStore({
      set: vi.fn(),
      setReference,
      get: vi.fn(),
      has: vi.fn(),
      remove: vi.fn(),
    });
    const reference = { source: "protonpass", path: "Work/Secrets" } as const;
    const ref = await store.putReference({ ...baseParams, reference });
    expect(ref).toBe("connector.a1b2c3.gmail.acc-1.oauth");
    expect(setReference).toHaveBeenCalledWith(ref, reference);
  });

  it("get uses reveal(caller) when requested and supported", async () => {
    const reveal = vi.fn(async () => "revealed");
    const get = vi.fn(async () => "plain");
    const store = createConnectorCredentialStore({
      set: vi.fn(),
      reveal,
      get,
      has: vi.fn(),
      remove: vi.fn(),
    });
    await expect(store.get("ref", { reveal: true, caller: "admin" })).resolves.toBe("revealed");
    expect(reveal).toHaveBeenCalledWith("ref", "admin");
    expect(get).not.toHaveBeenCalled();
  });

  it("get falls back to plain get when reveal is unsupported or not requested", async () => {
    const get = vi.fn(async () => "plain");
    const store = createConnectorCredentialStore({
      set: vi.fn(),
      get,
      has: vi.fn(),
      remove: vi.fn(),
    });
    await expect(store.get("ref", { reveal: true })).resolves.toBe("plain");
    await expect(store.get("ref")).resolves.toBe("plain");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("has and remove delegate to the vault", async () => {
    const has = vi.fn(async () => true);
    const remove = vi.fn(async () => {});
    const store = createConnectorCredentialStore({
      set: vi.fn(),
      get: vi.fn(),
      has,
      remove,
    });
    await expect(store.has("ref")).resolves.toBe(true);
    await store.remove("ref");
    expect(has).toHaveBeenCalledWith("ref");
    expect(remove).toHaveBeenCalledWith("ref");
  });
});
