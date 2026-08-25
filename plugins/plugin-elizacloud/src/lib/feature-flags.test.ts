import { afterEach, describe, expect, it, vi } from "vitest";
import { isCloudWalletEnabled } from "./feature-flags";

const FLAG = "ENABLE_CLOUD_WALLET";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("elizacloud ENABLE_CLOUD_WALLET gate", () => {
  it("defaults to disabled when the variable is unset or empty", () => {
    vi.stubEnv(FLAG, undefined);
    expect(isCloudWalletEnabled()).toBe(false);
    vi.stubEnv(FLAG, "");
    expect(isCloudWalletEnabled()).toBe(false);
  });

  it("accepts canonical truthy spellings, trimmed and case-insensitive", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "on", "  On"]) {
      vi.stubEnv(FLAG, value);
      expect(isCloudWalletEnabled()).toBe(true);
    }
  });

  it("accepts canonical falsy spellings", () => {
    for (const value of ["0", "false", "FALSE", "no", "off", " NO "]) {
      vi.stubEnv(FLAG, value);
      expect(isCloudWalletEnabled()).toBe(false);
    }
  });

  it("fails closed on unknown values instead of enabling the wallet", () => {
    for (const value of ["banana", "2", "enabled", "t", "f", "yesplease"]) {
      vi.stubEnv(FLAG, value);
      expect(isCloudWalletEnabled()).toBe(false);
    }
  });
});
