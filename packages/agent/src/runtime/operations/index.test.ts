/**
 * Unit coverage for the RuntimeOperation public-surface barrel. Drives the
 * real re-exports: exact runtime namespace keys, reference identity with
 * each sibling implementation, and live calls through the barrel for the
 * classifier, cold strategy, vault-ref helpers, and health checker.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { classifyOperation, defaultClassifier } from "./classifier.ts";
import { createColdStrategy } from "./cold-strategy.ts";
import { getDefaultHealthChecker, HealthChecker } from "./health.ts";
import {
  builtInHealthChecks,
  dbConnectionCheck,
  essentialServicesCheck,
  providerSmokeCheck,
  runtimeReadyCheck,
} from "./health-checks.ts";
import * as barrel from "./index.ts";
import { DefaultRuntimeOperationManager } from "./manager.ts";
import { createHotStrategy } from "./reload-hot.ts";
import {
  FilesystemRuntimeOperationRepository,
  getDefaultRepository,
} from "./repository.ts";
import type { OperationPhase } from "./types.ts";
import {
  _resetDefaultSecretsManagerForTesting,
  defaultSecretsManager,
  formatVaultRef,
  isVaultRef,
  parseVaultRef,
  persistProviderApiKey,
  resolveConfigEnvForProcess,
  resolveConnectorSecretSettings,
  resolveProviderApiKey,
  vaultKeyForProviderApiKey,
} from "./vault-bridge.ts";

const EXPECTED_RUNTIME_EXPORTS = [
  "_resetDefaultSecretsManagerForTesting",
  "builtInHealthChecks",
  "classifyOperation",
  "createColdStrategy",
  "createHotStrategy",
  "dbConnectionCheck",
  "DefaultRuntimeOperationManager",
  "defaultClassifier",
  "defaultSecretsManager",
  "essentialServicesCheck",
  "FilesystemRuntimeOperationRepository",
  "formatVaultRef",
  "getDefaultHealthChecker",
  "getDefaultRepository",
  "HealthChecker",
  "isVaultRef",
  "parseVaultRef",
  "persistProviderApiKey",
  "providerSmokeCheck",
  "resolveConfigEnvForProcess",
  "resolveConnectorSecretSettings",
  "resolveProviderApiKey",
  "runtimeReadyCheck",
  "vaultKeyForProviderApiKey",
];

describe("runtime operations barrel namespace", () => {
  it("exposes exactly the documented runtime exports", () => {
    expect(Object.keys(barrel).sort()).toEqual(
      [...EXPECTED_RUNTIME_EXPORTS].sort(),
    );
  });

  it("keeps sibling-internal helpers out of the public surface", () => {
    const keys = Object.keys(barrel);
    expect(keys).not.toContain("describeError");
    expect(keys).not.toContain("VaultResolveError");
    expect(keys).not.toContain("resolveOptimizedPromptIntegrityKey");
  });
});

describe("barrel re-export identity", () => {
  it("re-exports classifier bindings unchanged", () => {
    expect(barrel.classifyOperation).toBe(classifyOperation);
    expect(barrel.defaultClassifier).toBe(defaultClassifier);
  });

  it("re-exports strategy factories unchanged", () => {
    expect(barrel.createColdStrategy).toBe(createColdStrategy);
    expect(barrel.createHotStrategy).toBe(createHotStrategy);
  });

  it("re-exports health checker bindings unchanged", () => {
    expect(barrel.HealthChecker).toBe(HealthChecker);
    expect(barrel.getDefaultHealthChecker).toBe(getDefaultHealthChecker);
  });

  it("re-exports the built-in health checks unchanged", () => {
    expect(barrel.builtInHealthChecks).toBe(builtInHealthChecks);
    expect(barrel.runtimeReadyCheck).toBe(runtimeReadyCheck);
    expect(barrel.essentialServicesCheck).toBe(essentialServicesCheck);
    expect(barrel.dbConnectionCheck).toBe(dbConnectionCheck);
    expect(barrel.providerSmokeCheck).toBe(providerSmokeCheck);
  });

  it("re-exports the manager class unchanged", () => {
    expect(barrel.DefaultRuntimeOperationManager).toBe(
      DefaultRuntimeOperationManager,
    );
  });

  it("re-exports repository bindings unchanged", () => {
    expect(barrel.FilesystemRuntimeOperationRepository).toBe(
      FilesystemRuntimeOperationRepository,
    );
    expect(barrel.getDefaultRepository).toBe(getDefaultRepository);
  });

  it("re-exports vault bridge bindings unchanged", () => {
    expect(barrel.formatVaultRef).toBe(formatVaultRef);
    expect(barrel.isVaultRef).toBe(isVaultRef);
    expect(barrel.parseVaultRef).toBe(parseVaultRef);
    expect(barrel.vaultKeyForProviderApiKey).toBe(vaultKeyForProviderApiKey);
    expect(barrel.resolveConfigEnvForProcess).toBe(resolveConfigEnvForProcess);
    expect(barrel.resolveConnectorSecretSettings).toBe(
      resolveConnectorSecretSettings,
    );
    expect(barrel.persistProviderApiKey).toBe(persistProviderApiKey);
    expect(barrel.resolveProviderApiKey).toBe(resolveProviderApiKey);
    expect(barrel.defaultSecretsManager).toBe(defaultSecretsManager);
    expect(barrel._resetDefaultSecretsManagerForTesting).toBe(
      _resetDefaultSecretsManagerForTesting,
    );
  });
});

describe("barrel bindings drive real behavior", () => {
  it("classifies intents through the re-exported classifier", () => {
    expect(barrel.classifyOperation({ kind: "restart", reason: "" }, {})).toBe(
      "cold",
    );
    expect(
      barrel.classifyOperation(
        { kind: "provider-switch", provider: "openai" },
        { currentProvider: "openai" },
      ),
    ).toBe("hot");
    expect(
      barrel.classifyOperation(
        { kind: "config-reload", changedPaths: ["env.OPENAI_API_KEY"] },
        {},
      ),
    ).toBe("hot");
    expect(
      barrel.classifyOperation(
        { kind: "config-reload", changedPaths: ["plugins.enabled"] },
        {},
      ),
    ).toBe("cold");
  });

  it("re-exported defaultClassifier matches classifyOperation", () => {
    const cases = [
      [{ kind: "restart", reason: "manual" }, {}],
      [
        { kind: "provider-switch", provider: "openai-subscription" },
        { currentProvider: "openai" },
      ],
      [{ kind: "config-reload", changedPaths: ["vars.timezone"] }, {}],
    ] as const;
    for (const [intent, ctx] of cases) {
      expect(barrel.defaultClassifier(intent, ctx)).toBe(
        barrel.classifyOperation(intent, ctx),
      );
    }
  });

  it("runs a cold restart end-to-end through the re-exported factory", async () => {
    const replacementRuntime = { agentId: "replacement-agent" } as AgentRuntime;
    let receivedReason = "";
    const phases: OperationPhase[] = [];

    const strategy = barrel.createColdStrategy({
      restartRuntime: async (reason) => {
        receivedReason = reason;
        return replacementRuntime;
      },
    });

    expect(strategy.tier).toBe("cold");

    const returned = await strategy.apply({
      runtime: { agentId: "old-agent" } as AgentRuntime,
      intent: { kind: "restart", reason: "manual restart" },
      reportPhase: async (phase) => {
        phases.push(phase);
      },
    });

    expect(returned).toBe(replacementRuntime);
    expect(receivedReason).toContain("restart");
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe("cold-restart");
    expect(phases[0].status).toBe("succeeded");
    expect(typeof phases[0].startedAt).toBe("number");
    expect(typeof phases[0].finishedAt).toBe("number");
  });

  it("round-trips vault refs through the re-exported helpers", () => {
    const key = "providers.openai.api-key";
    const ref = barrel.formatVaultRef(key);

    expect(ref).toBe(`vault://${key}`);
    expect(barrel.isVaultRef(ref)).toBe(true);
    expect(barrel.isVaultRef(key)).toBe(false);
    expect(barrel.isVaultRef("vault://")).toBe(false);
    expect(barrel.parseVaultRef(ref)).toBe(key);
    expect(barrel.parseVaultRef("not-a-ref")).toBe(null);

    expect(() => barrel.formatVaultRef("")).toThrowError(TypeError);
    expect(() => barrel.vaultKeyForProviderApiKey("")).toThrowError(TypeError);
    expect(() => barrel.vaultKeyForProviderApiKey("has.dot")).toThrowError(
      TypeError,
    );
    expect(barrel.vaultKeyForProviderApiKey("anthropic")).toBe(
      "providers.anthropic.api-key",
    );
  });

  it("exposes the four built-in health checks in order with their metadata", () => {
    expect([...barrel.builtInHealthChecks]).toEqual([
      barrel.runtimeReadyCheck,
      barrel.essentialServicesCheck,
      barrel.dbConnectionCheck,
      barrel.providerSmokeCheck,
    ]);
    expect(barrel.runtimeReadyCheck).toMatchObject({
      name: "runtime-ready",
      required: true,
      timeoutMs: 1000,
    });
    expect(barrel.essentialServicesCheck).toMatchObject({
      name: "essential-services",
      required: true,
      timeoutMs: 2000,
    });
    expect(barrel.dbConnectionCheck).toMatchObject({
      name: "db-connection",
      required: true,
      timeoutMs: 1500,
    });
    expect(barrel.providerSmokeCheck).toMatchObject({
      name: "provider-smoke",
      required: true,
      timeoutMs: 5000,
    });
  });

  it("constructs an empty HealthChecker whose report passes", async () => {
    const checker = new barrel.HealthChecker();
    await expect(
      checker.runForRuntime({ agentId: "agent-id" } as AgentRuntime),
    ).resolves.toEqual({ passed: [], failed: [], ok: true });
  });
});
