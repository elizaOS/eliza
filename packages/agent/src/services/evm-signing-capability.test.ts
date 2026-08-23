/**
 * Covers resolveEvmSigningCapability, the env-driven EVM signer path used by
 * auto-enable and wallet diagnostics. Cases pass a constructed ProcessEnv so
 * the real resolver is exercised; process.env is mutated only for the
 * default-argument path and restored afterward.
 */
import { describe, expect, it } from "vitest";
import { resolveEvmSigningCapability } from "./evm-signing-capability.ts";

const NONE = {
  kind: "none" as const,
  canSign: false,
  reason: "No EVM signing path configured",
};

const LOCAL = {
  kind: "local" as const,
  canSign: true,
  reason: "env: EVM_PRIVATE_KEY",
};

const STEWARD_SELF = {
  kind: "steward-self" as const,
  canSign: true,
  reason: "self-hosted Steward wallet",
};

const STEWARD_CLOUD = {
  kind: "steward-cloud" as const,
  canSign: true,
  reason: "cloud-provisioned Steward wallet",
};

const CLOUD_VIEW_ONLY = {
  kind: "cloud-view-only" as const,
  canSign: false,
  reason: "Cloud wallet provisioned (view-only — local signing unavailable)",
};

const STEWARD = {
  STEWARD_API_URL: "https://steward.example",
  STEWARD_AGENT_TOKEN: "agent-token",
} satisfies NodeJS.ProcessEnv;

const PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CLOUD_ADDRESS = "0x1111111111111111111111111111111111111111";

const ENV_KEYS = [
  "EVM_PRIVATE_KEY",
  "STEWARD_API_URL",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CLOUD_EVM_ADDRESS",
] as const;

const savedProcessEnv: Partial<
  Record<(typeof ENV_KEYS)[number], string | undefined>
> = {};

function snapshotProcessEnv(): void {
  for (const key of ENV_KEYS) {
    savedProcessEnv[key] = process.env[key];
  }
}

function restoreProcessEnv(): void {
  for (const key of ENV_KEYS) {
    const previous = savedProcessEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("resolveEvmSigningCapability", () => {
  it("reports none when the env is empty", () => {
    expect(resolveEvmSigningCapability({})).toEqual(NONE);
  });

  it("treats whitespace-only private keys as unset", () => {
    expect(resolveEvmSigningCapability({ EVM_PRIVATE_KEY: "   \t" })).toEqual(
      NONE,
    );
  });

  it("resolves a concrete EVM_PRIVATE_KEY as a local signer", () => {
    expect(
      resolveEvmSigningCapability({ EVM_PRIVATE_KEY: PRIVATE_KEY }),
    ).toEqual(LOCAL);
  });

  it("trims surrounding whitespace on a concrete private key", () => {
    expect(
      resolveEvmSigningCapability({
        EVM_PRIVATE_KEY: `  ${PRIVATE_KEY}  `,
      }),
    ).toEqual(LOCAL);
  });

  it.each([
    "REDACTED",
    "[REDACTED]",
    "[ REDACTED ]",
    "placeholder",
    "TODO",
    "todo",
    "[TODO]",
    "CHANGEME",
    "EMPTY",
    "empty",
  ])("treats placeholder private key %j as unset", (value) => {
    expect(resolveEvmSigningCapability({ EVM_PRIVATE_KEY: value })).toEqual(
      NONE,
    );
  });

  it("does not treat a private key that merely contains a placeholder word as unset", () => {
    expect(
      resolveEvmSigningCapability({
        EVM_PRIVATE_KEY: "REDACTED-NOT-A-PLACEHOLDER",
      }),
    ).toEqual(LOCAL);
  });

  it("resolves self-hosted Steward when URL and token are set", () => {
    expect(resolveEvmSigningCapability({ ...STEWARD })).toEqual(STEWARD_SELF);
  });

  it("resolves cloud Steward only when ELIZA_CLOUD_PROVISIONED is exactly 1", () => {
    expect(
      resolveEvmSigningCapability({
        ...STEWARD,
        ELIZA_CLOUD_PROVISIONED: "1",
      }),
    ).toEqual(STEWARD_CLOUD);
  });

  it.each(["0", "true", "yes", " 1", "1 "])(
    "keeps Steward self-hosted when ELIZA_CLOUD_PROVISIONED is %j",
    (value) => {
      expect(
        resolveEvmSigningCapability({
          ...STEWARD,
          ELIZA_CLOUD_PROVISIONED: value,
        }),
      ).toEqual(STEWARD_SELF);
    },
  );

  it("trims Steward URL and token before accepting them", () => {
    expect(
      resolveEvmSigningCapability({
        STEWARD_API_URL: "  https://steward.example  ",
        STEWARD_AGENT_TOKEN: "  agent-token  ",
      }),
    ).toEqual(STEWARD_SELF);
  });

  it("does not accept Steward when only the URL is set", () => {
    expect(
      resolveEvmSigningCapability({
        STEWARD_API_URL: "https://steward.example",
      }),
    ).toEqual(NONE);
  });

  it("does not accept Steward when only the token is set", () => {
    expect(
      resolveEvmSigningCapability({
        STEWARD_AGENT_TOKEN: "agent-token",
      }),
    ).toEqual(NONE);
  });

  it("does not accept Steward when the URL is whitespace-only", () => {
    expect(
      resolveEvmSigningCapability({
        STEWARD_API_URL: "   ",
        STEWARD_AGENT_TOKEN: "agent-token",
      }),
    ).toEqual(NONE);
  });

  it("does not apply placeholder rejection to Steward credentials", () => {
    expect(
      resolveEvmSigningCapability({
        STEWARD_API_URL: "REDACTED",
        STEWARD_AGENT_TOKEN: "PLACEHOLDER",
      }),
    ).toEqual(STEWARD_SELF);
  });

  it("resolves a cloud-bind address as view-only when no signer is present", () => {
    expect(
      resolveEvmSigningCapability({
        ELIZA_CLOUD_EVM_ADDRESS: CLOUD_ADDRESS,
      }),
    ).toEqual(CLOUD_VIEW_ONLY);
  });

  it("trims the cloud-bind address before accepting it", () => {
    expect(
      resolveEvmSigningCapability({
        ELIZA_CLOUD_EVM_ADDRESS: `  ${CLOUD_ADDRESS}  `,
      }),
    ).toEqual(CLOUD_VIEW_ONLY);
  });

  it("treats a whitespace-only cloud-bind address as unset", () => {
    expect(
      resolveEvmSigningCapability({
        ELIZA_CLOUD_EVM_ADDRESS: "   ",
      }),
    ).toEqual(NONE);
  });

  it("does not apply placeholder rejection to the cloud-bind address", () => {
    expect(
      resolveEvmSigningCapability({
        ELIZA_CLOUD_EVM_ADDRESS: "REDACTED",
      }),
    ).toEqual(CLOUD_VIEW_ONLY);
  });

  it("prefers a local private key over Steward and a cloud-bind address", () => {
    expect(
      resolveEvmSigningCapability({
        EVM_PRIVATE_KEY: PRIVATE_KEY,
        ...STEWARD,
        ELIZA_CLOUD_PROVISIONED: "1",
        ELIZA_CLOUD_EVM_ADDRESS: CLOUD_ADDRESS,
      }),
    ).toEqual(LOCAL);
  });

  it("prefers Steward over a cloud-bind address when the private key is absent", () => {
    expect(
      resolveEvmSigningCapability({
        ...STEWARD,
        ELIZA_CLOUD_EVM_ADDRESS: CLOUD_ADDRESS,
      }),
    ).toEqual(STEWARD_SELF);
  });

  it("falls through from a placeholder private key to Steward", () => {
    expect(
      resolveEvmSigningCapability({
        EVM_PRIVATE_KEY: "[REDACTED]",
        ...STEWARD,
      }),
    ).toEqual(STEWARD_SELF);
  });

  it("falls through from a placeholder private key to cloud-view-only", () => {
    expect(
      resolveEvmSigningCapability({
        EVM_PRIVATE_KEY: "REDACTED",
        ELIZA_CLOUD_EVM_ADDRESS: CLOUD_ADDRESS,
      }),
    ).toEqual(CLOUD_VIEW_ONLY);
  });

  it("falls through from incomplete Steward credentials to cloud-view-only", () => {
    expect(
      resolveEvmSigningCapability({
        STEWARD_API_URL: "https://steward.example",
        ELIZA_CLOUD_EVM_ADDRESS: CLOUD_ADDRESS,
      }),
    ).toEqual(CLOUD_VIEW_ONLY);
  });

  it("reads process.env when no env argument is passed", () => {
    snapshotProcessEnv();
    try {
      delete process.env.STEWARD_API_URL;
      delete process.env.STEWARD_AGENT_TOKEN;
      delete process.env.ELIZA_CLOUD_PROVISIONED;
      delete process.env.ELIZA_CLOUD_EVM_ADDRESS;
      process.env.EVM_PRIVATE_KEY = PRIVATE_KEY;

      expect(resolveEvmSigningCapability()).toEqual(LOCAL);
    } finally {
      restoreProcessEnv();
    }
  });

  it("does not fall back to process.env when an explicit env object is passed", () => {
    snapshotProcessEnv();
    try {
      process.env.EVM_PRIVATE_KEY = PRIVATE_KEY;
      process.env.STEWARD_API_URL = STEWARD.STEWARD_API_URL;
      process.env.STEWARD_AGENT_TOKEN = STEWARD.STEWARD_AGENT_TOKEN;
      process.env.ELIZA_CLOUD_EVM_ADDRESS = CLOUD_ADDRESS;

      expect(resolveEvmSigningCapability({})).toEqual(NONE);
    } finally {
      restoreProcessEnv();
    }
  });
});
