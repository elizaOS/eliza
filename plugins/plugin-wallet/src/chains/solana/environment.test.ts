/**
 * Validation-gate tests for Solana runtime settings.
 *
 * Materiality: `validateSolanaConfig` is the permission/credential gate for
 * every Solana plugin action — it decides whether a wallet configuration is
 * usable at all. The union schema (private+public key OR TEE salt) is subtle;
 * these tests pin the reject paths so a future schema loosening (e.g. making
 * RPC URL optional) cannot silently ship a config that would fail at runtime.
 */
import { describe, expect, it } from "vitest";
import { solanaEnvSchema, validateSolanaConfig } from "./environment";

function makeRuntime(settings: Record<string, string | undefined>) {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as Parameters<typeof validateSolanaConfig>[0];
}

const VALID = {
  SOLANA_PRIVATE_KEY: "pk",
  SOLANA_PUBLIC_KEY: "pub",
  SLIPPAGE: "0.05",
  SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
};

describe("solanaEnvSchema", () => {
  it("accepts private key + public key with slippage and RPC URL", () => {
    const res = solanaEnvSchema.safeParse(VALID);
    expect(res.success).toBe(true);
  });

  it("accepts the TEE salt alternative without key pair", () => {
    const res = solanaEnvSchema.safeParse({
      SOLANA_SECRET_SALT: "salt",
      SLIPPAGE: "0.05",
      SOLANA_RPC_URL: "https://rpc",
    });
    expect(res.success).toBe(true);
  });

  it("rejects a missing RPC URL with a field-level issue", () => {
    const res = solanaEnvSchema.safeParse({ ...VALID, SOLANA_RPC_URL: undefined });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes("SOLANA_RPC_URL"))).toBe(true);
    }
  });

  it("rejects a missing public key when only a private key is present", () => {
    const res = solanaEnvSchema.safeParse({
      SOLANA_PRIVATE_KEY: "pk",
      SLIPPAGE: "0.05",
      SOLANA_RPC_URL: "https://rpc",
    });
    // Neither union branch is satisfiable: branch 1 needs a public key,
    // branch 2 needs a non-empty secret salt.
    expect(res.success).toBe(false);
  });

  it("rejects an empty secret salt and no key pair (neither branch satisfied)", () => {
    const res = solanaEnvSchema.safeParse({
      SOLANA_SECRET_SALT: "",
      SLIPPAGE: "0.05",
      SOLANA_RPC_URL: "https://rpc",
    });
    expect(res.success).toBe(false);
  });
});

describe("validateSolanaConfig", () => {
  it("resolves the validated config for a valid runtime", async () => {
    const config = await validateSolanaConfig(makeRuntime(VALID));
    expect(config.SOLANA_RPC_URL).toBe("https://api.mainnet-beta.solana.com");
    expect(config.SLIPPAGE).toBe("0.05");
  });

  it("throws a combined human-readable error listing missing fields", async () => {
    await expect(validateSolanaConfig(makeRuntime({ SLIPPAGE: "0.05" }))).rejects.toThrow(
      /Solana configuration validation failed/
    );
  });

  it("names the missing RPC URL in the error", async () => {
    await expect(
      validateSolanaConfig(
        makeRuntime({ SOLANA_PRIVATE_KEY: "pk", SOLANA_PUBLIC_KEY: "pub", SLIPPAGE: "0.05" })
      )
    ).rejects.toThrow(/SOLANA_RPC_URL/);
  });

  it("rejects an empty-string public key instead of treating it as valid", async () => {
    await expect(
      validateSolanaConfig(
        makeRuntime({
          SOLANA_PRIVATE_KEY: "pk",
          SOLANA_PUBLIC_KEY: "",
          SLIPPAGE: "0.05",
          SOLANA_RPC_URL: "https://rpc",
        })
      )
    ).rejects.toThrow(/Solana public key is required/);
  });

  it("rethrows non-validation errors from getSetting unchanged", async () => {
    const broken = {
      getSetting: () => {
        throw new Error("boom");
      },
    } as unknown as Parameters<typeof validateSolanaConfig>[0];
    await expect(validateSolanaConfig(broken)).rejects.toThrow("boom");
  });
});
