import { describe, expect, it } from "vitest";
import {
  evmAutoEnableReasonFromCapability,
  resolveEvmSigningCapability,
} from "./evm-signing-capability.js";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as unknown as NodeJS.ProcessEnv;
}

describe("resolveEvmSigningCapability", () => {
  it("returns local when EVM_PRIVATE_KEY is concrete", () => {
    const cap = resolveEvmSigningCapability(
      env({ EVM_PRIVATE_KEY: "0xabc123" }),
    );
    expect(cap).toEqual({
      kind: "local",
      canSign: true,
      reason: "env: EVM_PRIVATE_KEY",
    });
  });

  it("ignores placeholder EVM_PRIVATE_KEY values", () => {
    const cap = resolveEvmSigningCapability(
      env({ EVM_PRIVATE_KEY: "[REDACTED]" }),
    );
    expect(cap.kind).toBe("none");
  });

  it("returns steward-self when API URL + token are set without cloud flag", () => {
    const cap = resolveEvmSigningCapability(
      env({
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_TOKEN: "tok",
      }),
    );
    expect(cap).toEqual({
      kind: "steward-self",
      canSign: true,
      reason: "self-hosted Steward wallet",
    });
  });

  it("returns steward-cloud when ELIZA_CLOUD_PROVISIONED=1 and creds are set", () => {
    const cap = resolveEvmSigningCapability(
      env({
        STEWARD_API_URL: "https://steward.cloud",
        STEWARD_AGENT_TOKEN: "tok",
        ELIZA_CLOUD_PROVISIONED: "1",
      }),
    );
    expect(cap).toEqual({
      kind: "steward-cloud",
      canSign: true,
      reason: "cloud-provisioned Steward wallet",
    });
  });

  it("returns cloud-view-only when only a cloud address is persisted", () => {
    const cap = resolveEvmSigningCapability(
      env({ MILADY_CLOUD_EVM_ADDRESS: "0xabc" }),
    );
    expect(cap.kind).toBe("cloud-view-only");
    expect(cap.canSign).toBe(false);
    expect(cap.reason).toMatch(/view-only/i);
  });

  it("prefers local over steward when both are present", () => {
    const cap = resolveEvmSigningCapability(
      env({
        EVM_PRIVATE_KEY: "0xabc123",
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_TOKEN: "tok",
      }),
    );
    expect(cap.kind).toBe("local");
  });

  it("returns none with empty env", () => {
    const cap = resolveEvmSigningCapability(env({}));
    expect(cap).toEqual({
      kind: "none",
      canSign: false,
      reason: "No EVM signing path configured",
    });
  });
});

describe("evmAutoEnableReasonFromCapability", () => {
  it("returns the reason when a signing path exists", () => {
    expect(
      evmAutoEnableReasonFromCapability(env({ EVM_PRIVATE_KEY: "0xa" })),
    ).toBe("env: EVM_PRIVATE_KEY");
  });

  it("returns null for cloud-view-only (no signer wired)", () => {
    expect(
      evmAutoEnableReasonFromCapability(
        env({ MILADY_CLOUD_EVM_ADDRESS: "0xabc" }),
      ),
    ).toBeNull();
  });

  it("returns null when nothing is configured", () => {
    expect(evmAutoEnableReasonFromCapability(env({}))).toBeNull();
  });
});
