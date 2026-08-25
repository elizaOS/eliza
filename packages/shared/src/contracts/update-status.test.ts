/**
 * Unit tests for agent self-update status contracts and Zod schemas.
 */

import { describe, expect, it } from "vitest";
import {
  AgentInstallMethodSchema,
  AgentUpdateAuthoritySchema,
  AgentUpdateNextActionSchema,
  AgentUpdateStatusSchema,
  ReleaseChannelSchema,
} from "./update-status.js";

describe("ReleaseChannelSchema", () => {
  it("accepts valid release channels", () => {
    expect(ReleaseChannelSchema.parse("stable")).toBe("stable");
    expect(ReleaseChannelSchema.parse("beta")).toBe("beta");
    expect(ReleaseChannelSchema.parse("nightly")).toBe("nightly");
  });

  it("rejects invalid release channels", () => {
    expect(() => ReleaseChannelSchema.parse("alpha")).toThrow();
    expect(() => ReleaseChannelSchema.parse("")).toThrow();
    expect(() => ReleaseChannelSchema.parse(null)).toThrow();
    expect(() => ReleaseChannelSchema.parse(123)).toThrow();
  });
});

describe("AgentInstallMethodSchema", () => {
  it("accepts known install methods", () => {
    const methods = [
      "npm-global",
      "bun-global",
      "homebrew",
      "snap",
      "apt",
      "flatpak",
      "local-dev",
      "unknown",
    ] as const;

    for (const method of methods) {
      expect(AgentInstallMethodSchema.parse(method)).toBe(method);
    }
  });

  it("rejects unknown install methods in the strict enum schema", () => {
    expect(() => AgentInstallMethodSchema.parse("cargo")).toThrow();
    expect(() => AgentInstallMethodSchema.parse("")).toThrow();
    expect(() => AgentInstallMethodSchema.parse(undefined)).toThrow();
  });
});

describe("AgentUpdateAuthoritySchema", () => {
  it("accepts valid update authorities", () => {
    const authorities = [
      "package-manager",
      "os-package-manager",
      "developer",
      "operator",
    ] as const;

    for (const auth of authorities) {
      expect(AgentUpdateAuthoritySchema.parse(auth)).toBe(auth);
    }
  });

  it("rejects invalid update authorities", () => {
    expect(() => AgentUpdateAuthoritySchema.parse("root")).toThrow();
    expect(() => AgentUpdateAuthoritySchema.parse("admin")).toThrow();
  });
});

describe("AgentUpdateNextActionSchema", () => {
  it("accepts valid next actions", () => {
    const actions = [
      "run-package-manager-command",
      "run-git-pull",
      "review-installation",
      "none",
    ] as const;

    for (const action of actions) {
      expect(AgentUpdateNextActionSchema.parse(action)).toBe(action);
    }
  });

  it("rejects invalid next actions", () => {
    expect(() => AgentUpdateNextActionSchema.parse("restart")).toThrow();
  });
});

describe("AgentUpdateStatusSchema", () => {
  const validStatus = {
    currentVersion: "1.0.0",
    channel: "stable" as const,
    installMethod: "bun-global" as const,
    updateAuthority: "package-manager" as const,
    nextAction: "run-package-manager-command" as const,
    canAutoUpdate: true,
    canExecuteUpdate: false,
    remoteDisplay: true,
    updateCommand: "bun update -g @elizaos/agent",
    updateInstructions: "Run the update command in your terminal",
    updateAvailable: true,
    latestVersion: "1.1.0",
    channels: {
      stable: "1.1.0",
      beta: "1.2.0-beta.1",
      nightly: null,
    },
    distTags: {
      stable: "1.1.0",
      beta: "1.2.0-beta.1",
      nightly: "1.3.0-nightly.20260823",
    },
    lastCheckAt: "2026-08-23T12:00:00.000Z",
    error: null,
  };

  it("parses a complete valid status object", () => {
    const result = AgentUpdateStatusSchema.parse(validStatus);
    expect(result.currentVersion).toBe("1.0.0");
    expect(result.channel).toBe("stable");
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("1.1.0");
    expect(result.channels.stable).toBe("1.1.0");
    expect(result.channels.nightly).toBeNull();
    expect(result.error).toBeNull();
  });

  it("allows string installMethod extensions in AgentUpdateStatusSchema", () => {
    const customMethod = {
      ...validStatus,
      installMethod: "docker-container",
    };
    const result = AgentUpdateStatusSchema.parse(customMethod);
    expect(result.installMethod).toBe("docker-container");
  });

  it("allows optional fields to be omitted", () => {
    const minimalStatus = {
      currentVersion: "1.0.0",
      channel: "beta" as const,
      installMethod: "local-dev" as const,
      updateAvailable: false,
      latestVersion: null,
      channels: {
        stable: "1.0.0",
        beta: "1.0.0",
        nightly: "1.0.0",
      },
      distTags: {
        stable: "1.0.0",
        beta: "1.0.0",
        nightly: "1.0.0",
      },
      lastCheckAt: null,
      error: "Network timeout during check",
    };
    const result = AgentUpdateStatusSchema.parse(minimalStatus);
    expect(result.updateAuthority).toBeUndefined();
    expect(result.nextAction).toBeUndefined();
    expect(result.canAutoUpdate).toBeUndefined();
    expect(result.updateCommand).toBeUndefined();
    expect(result.error).toBe("Network timeout during check");
  });

  it("strictly rejects extraneous unexpected properties", () => {
    const withExtra = {
      ...validStatus,
      unexpectedField: "malicious",
    };
    expect(() => AgentUpdateStatusSchema.parse(withExtra)).toThrow();
  });

  it("rejects missing required fields", () => {
    const { currentVersion, ...missingVersion } = validStatus;
    expect(() => AgentUpdateStatusSchema.parse(missingVersion)).toThrow();

    const { updateAvailable, ...missingAvailable } = validStatus;
    expect(() => AgentUpdateStatusSchema.parse(missingAvailable)).toThrow();

    const { channels, ...missingChannels } = validStatus;
    expect(() => AgentUpdateStatusSchema.parse(missingChannels)).toThrow();
  });
});
