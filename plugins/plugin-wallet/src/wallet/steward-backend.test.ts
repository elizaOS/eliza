import { beforeEach, describe, expect, it, vi } from "vitest";
import { StewardUnavailableError } from "./errors";
import { StewardBackend } from "./steward-backend";

const h = vi.hoisted(() => {
  const initStewardEvmAccount = vi.fn(async () => null);
  const resolveStewardEvmConfig = vi.fn(() => null);
  const fetchStewardVaultChainAddresses = vi.fn(async () => ({
    evm: null,
    solana: null,
  }));
  return {
    initStewardEvmAccount,
    resolveStewardEvmConfig,
    fetchStewardVaultChainAddresses,
  };
});

vi.mock("@elizaos/app-steward", () => ({
  initStewardEvmAccount: h.initStewardEvmAccount,
  resolveStewardEvmConfig: h.resolveStewardEvmConfig,
  fetchStewardVaultChainAddresses: h.fetchStewardVaultChainAddresses,
}));

const EVM_ACCOUNT = {
  address: "0x1111111111111111111111111111111111111111",
  signMessage: vi.fn(async () => "0xsig"),
  signTypedData: vi.fn(async () => "0xtyped"),
};

function mockSteward(
  overrides: {
    initStewardEvmAccount?: () => Promise<unknown>;
    resolveStewardEvmConfig?: () => unknown;
    fetchStewardVaultChainAddresses?: () => Promise<unknown>;
  } = {},
) {
  h.initStewardEvmAccount.mockReset();
  h.resolveStewardEvmConfig.mockReset();
  h.fetchStewardVaultChainAddresses.mockReset();
  // Default = success path; tests override only what they need. After
  // mockReset every fn falls back to its hoisted initial implementation
  // (init → null), so defaults are re-established explicitly here.
  h.initStewardEvmAccount.mockImplementation(
    overrides.initStewardEvmAccount ?? (async () => EVM_ACCOUNT),
  );
  h.resolveStewardEvmConfig.mockImplementation(
    overrides.resolveStewardEvmConfig ?? (() => DEFAULT_CFG),
  );
  h.fetchStewardVaultChainAddresses.mockImplementation(
    overrides.fetchStewardVaultChainAddresses ??
      (async () => ({ evm: EVM_ACCOUNT.address, solana: null })),
  );
}

const DEFAULT_CFG = {
  apiUrl: "https://steward.example.com",
  agentToken: "tok",
  agentId: "agent-1",
};

describe("StewardBackend.create", () => {
  beforeEach(() => {
    mockSteward({
      initStewardEvmAccount: async () => EVM_ACCOUNT,
      resolveStewardEvmConfig: () => DEFAULT_CFG,
      fetchStewardVaultChainAddresses: async () => ({
        evm: "0x1111111111111111111111111111111111111111",
        solana: null,
      }),
    });
  });

  it("throws StewardUnavailableError when EVM account init returns null", async () => {
    mockSteward({ initStewardEvmAccount: async () => null });
    await expect(
      StewardBackend.create({} as unknown as never),
    ).rejects.toBeInstanceOf(StewardUnavailableError);
  });

  it("throws StewardUnavailableError when config resolution returns null", async () => {
    mockSteward({ resolveStewardEvmConfig: () => null });
    await expect(
      StewardBackend.create({} as unknown as never),
    ).rejects.toBeInstanceOf(StewardUnavailableError);
  });

  it("wraps a vault addresses fetch failure as StewardUnavailableError", async () => {
    // Network/HTTP failures from the vault endpoint must be classified as
    // StewardUnavailableError so callers can fall back to the local backend;
    // leaking the raw error breaks the failover contract.
    const transportError = new Error("ECONNREFUSED 10.0.0.1:443");
    mockSteward({
      fetchStewardVaultChainAddresses: async () => {
        throw transportError;
      },
    });
    const err = await StewardBackend.create({} as unknown as never).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StewardUnavailableError);
    // The original transport error must be retained as `cause` so owner
    // diagnostics can distinguish network failure from a Steward-side error.
    expect((err as Error).cause).toBe(transportError);
  });

  it("treats an invalid solana vault address as no solana address", async () => {
    mockSteward({
      initStewardEvmAccount: async () => EVM_ACCOUNT,
      resolveStewardEvmConfig: () => DEFAULT_CFG,
      fetchStewardVaultChainAddresses: async () => ({
        evm: "0x1111111111111111111111111111111111111111",
        solana: "not-a-valid-base58-pubkey-!!!",
      }),
    });
    const backend = await StewardBackend.create({} as unknown as never);
    expect(backend.getAddresses().solana).toBeNull();
  });

  it("exposes the evm address from the steward account", async () => {
    const backend = await StewardBackend.create({} as unknown as never);
    expect(backend.getAddresses().evm).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });
});

describe("StewardBackend signing semantics", () => {
  let backend: StewardBackend;
  beforeEach(async () => {
    mockSteward({
      initStewardEvmAccount: async () => EVM_ACCOUNT,
      resolveStewardEvmConfig: () => DEFAULT_CFG,
      fetchStewardVaultChainAddresses: async () => ({
        evm: "0x1111111111111111111111111111111111111111",
        solana: null,
      }),
    });
    backend = await StewardBackend.create({} as unknown as never);
  });

  it("refuses solana signing even when the backend is available", () => {
    expect(backend.canSign("solana")).toBe(false);
    expect(backend.canSign("evm")).toBe(true);
  });

  it("getSolanaSigner always throws StewardUnavailableError", () => {
    expect(() => backend.getSolanaSigner()).toThrow(StewardUnavailableError);
  });

  it("signs a message through the steward account", async () => {
    const result = await backend.signMessage("user-1" as never, "0xdeadbeef");
    expect(result).toEqual({ kind: "signature", signature: "0xsig" });
    expect(EVM_ACCOUNT.signMessage).toHaveBeenCalledWith({
      message: { raw: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
    });
  });

  it("throws StewardUnavailableError when the account lacks signMessage", async () => {
    mockSteward({
      initStewardEvmAccount: async () => ({ address: "0x1234" }),
      resolveStewardEvmConfig: () => DEFAULT_CFG,
      fetchStewardVaultChainAddresses: async () => ({
        evm: null,
        solana: null,
      }),
    });
    const bare = await StewardBackend.create({} as unknown as never);
    await expect(
      bare.signMessage("user-1" as never, "0xdeadbeef"),
    ).rejects.toBeInstanceOf(StewardUnavailableError);
  });

  it("signs typed data through the steward account", async () => {
    const typed = { types: {}, primaryType: "Mail", domain: {}, message: {} };
    const result = await backend.signTypedData(
      "user-1" as never,
      typed as unknown as never,
    );
    expect(result).toEqual({ kind: "signature", signature: "0xtyped" });
    expect(EVM_ACCOUNT.signTypedData).toHaveBeenCalledWith(typed);
  });
});
