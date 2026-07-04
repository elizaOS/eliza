/**
 * Coverage for TrainingConfigService and its registration helper — the settings
 * extension the host SETTINGS action dispatches `toggle_training` to — using an
 * in-memory config, no disk or host runtime.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAINING_CONFIG,
  type TrainingConfig,
} from "../core/training-config.js";
import {
  registerTrainingConfigService,
  TRAINING_CONFIG_SERVICE,
  TrainingConfigService,
} from "./training-config-service.js";

function baseConfig(): TrainingConfig {
  return { ...DEFAULT_TRAINING_CONFIG, backends: ["native"] };
}

function makeService(initial: TrainingConfig = baseConfig()) {
  let stored = initial;
  const saved: TrainingConfig[] = [];
  const service = new TrainingConfigService(undefined, {
    loadConfig: () => stored,
    saveConfig: (config) => {
      stored = config;
      saved.push(config);
    },
  });
  return { service, saved, current: () => stored };
}

describe("TrainingConfigService.applyAutoTrainToggle", () => {
  it("toggles autoTrain off and persists, preserving other fields", () => {
    const { service, saved } = makeService(baseConfig());
    const summary = service.applyAutoTrainToggle({ enabled: false });
    expect(summary.autoTrain).toBe(false);
    // Unspecified fields keep their prior values.
    expect(summary.triggerThreshold).toBe(
      DEFAULT_TRAINING_CONFIG.triggerThreshold,
    );
    expect(summary.triggerCooldownHours).toBe(
      DEFAULT_TRAINING_CONFIG.triggerCooldownHours,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].autoTrain).toBe(false);
    expect(saved[0].backends).toEqual(["native"]);
  });

  it("floors the threshold and applies the cooldown", () => {
    const { service, current } = makeService();
    const summary = service.applyAutoTrainToggle({
      enabled: true,
      threshold: 250.9,
      cooldownHours: 6,
    });
    expect(summary).toEqual({
      autoTrain: true,
      triggerThreshold: 250,
      triggerCooldownHours: 6,
    });
    expect(current().triggerThreshold).toBe(250);
    expect(current().triggerCooldownHours).toBe(6);
  });

  it("leaves threshold/cooldown untouched when omitted", () => {
    const start: TrainingConfig = {
      ...baseConfig(),
      triggerThreshold: 42,
      triggerCooldownHours: 3,
    };
    const { service } = makeService(start);
    const summary = service.applyAutoTrainToggle({ enabled: true });
    expect(summary.triggerThreshold).toBe(42);
    expect(summary.triggerCooldownHours).toBe(3);
  });
});

describe("registerTrainingConfigService", () => {
  it("registers the service under TRAINING_CONFIG_SERVICE for host lookup", () => {
    const services = new Map<string, unknown[]>();
    const runtime = {
      services,
      getService: (name: string) => services.get(name)?.[0] ?? null,
    } as unknown as IAgentRuntime;

    const registered = registerTrainingConfigService(runtime, {
      loadConfig: baseConfig,
      saveConfig: () => {},
    });
    const looked = runtime.getService(TRAINING_CONFIG_SERVICE);
    expect(looked).toBe(registered);
    expect(
      typeof (looked as { applyAutoTrainToggle?: unknown })
        .applyAutoTrainToggle,
    ).toBe("function");
  });
});
