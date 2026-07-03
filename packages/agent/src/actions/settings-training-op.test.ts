import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { settingsAction } from "./settings-actions.ts";

// item 9: the host SETTINGS action must NOT import @elizaos/plugin-training.
// It dispatches `toggle_training` to a TrainingConfigService the plugin
// registers under the well-known name, and reports unavailable when the
// service is absent (plugin not loaded).

const TRAINING_CONFIG_SERVICE = "training_config_service";

interface AutoTrainToggleInput {
  enabled: boolean;
  threshold?: number;
  cooldownHours?: number;
}

function makeRuntime(service: unknown): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === TRAINING_CONFIG_SERVICE ? service : null,
  } as unknown as IAgentRuntime;
}

const MESSAGE = { entityId: "owner" } as unknown as Memory;

function invoke(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  return settingsAction.handler(runtime, MESSAGE, undefined, {
    parameters,
  } as HandlerOptions) as Promise<ActionResult>;
}

describe("SETTINGS toggle_training op (item 9)", () => {
  it("does not statically import @elizaos/plugin-training", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./settings-actions.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).not.toMatch(/from ["']@elizaos\/plugin-training["']/);
    expect(src).not.toMatch(/import\(\s*["']@elizaos\/plugin-training["']/);
  });

  it("reports unavailable when the training plugin is not loaded", async () => {
    const result = await invoke(makeRuntime(null), {
      action: "toggle_training",
      enabled: true,
    });
    expect(result.success).toBe(false);
    expect(result.values?.error).toBe("TRAINING_UNAVAILABLE");
  });

  it("reports unavailable when a registered service lacks the capability", async () => {
    // A service registered under the name but without applyAutoTrainToggle
    // must not be treated as the training config capability.
    const result = await invoke(makeRuntime({ somethingElse: () => {} }), {
      action: "toggle_training",
      enabled: false,
    });
    expect(result.success).toBe(false);
    expect(result.values?.error).toBe("TRAINING_UNAVAILABLE");
  });

  it("dispatches to the registered service and echoes its summary", async () => {
    const calls: AutoTrainToggleInput[] = [];
    const service = {
      applyAutoTrainToggle(input: AutoTrainToggleInput) {
        calls.push(input);
        return {
          autoTrain: input.enabled,
          triggerThreshold: input.threshold ?? 100,
          triggerCooldownHours: input.cooldownHours ?? 12,
        };
      },
    };
    const result = await invoke(makeRuntime(service), {
      action: "toggle_training",
      enabled: true,
      threshold: 250,
      cooldownHours: 6,
    });
    expect(result.success).toBe(true);
    expect(calls).toEqual([
      { enabled: true, threshold: 250, cooldownHours: 6 },
    ]);
    expect(result.data).toMatchObject({
      op: "toggle_training",
      autoTrain: true,
      triggerThreshold: 250,
      triggerCooldownHours: 6,
    });
    expect(result.text).toContain("Auto-training is now enabled");
  });

  it("surfaces a validation error before touching the service", async () => {
    let called = false;
    const service = {
      applyAutoTrainToggle() {
        called = true;
        return {
          autoTrain: true,
          triggerThreshold: 1,
          triggerCooldownHours: 1,
        };
      },
    };
    const result = await invoke(makeRuntime(service), {
      action: "toggle_training",
      enabled: true,
      threshold: -5,
    });
    expect(result.success).toBe(false);
    expect(result.values?.error).toBe("INVALID_THRESHOLD");
    expect(called).toBe(false);
  });

  it("translates a service throw into SETTINGS_TOGGLE_TRAINING_FAILED", async () => {
    const service = {
      applyAutoTrainToggle() {
        throw new Error("disk full");
      },
    };
    const result = await invoke(makeRuntime(service), {
      action: "toggle_training",
      enabled: true,
    });
    expect(result.success).toBe(false);
    expect(result.values?.error).toBe("SETTINGS_TOGGLE_TRAINING_FAILED");
  });
});
