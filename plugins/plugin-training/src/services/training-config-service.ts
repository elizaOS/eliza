/**
 * TrainingConfigService — the plugin-training-owned settings extension the host
 * SETTINGS action dispatches `toggle_training` to.
 *
 * Previously the host action (`@elizaos/agent`) reached into this plugin via a
 * computed-specifier `import("@elizaos/plugin-training")` to call
 * `loadTrainingConfig`/`saveTrainingConfig` — a reverse dependency edge (host →
 * plugin) that the agent package did not even declare. That business logic now
 * lives here, behind a runtime service the host looks up by name: the plugin
 * contributes the capability, the host stays a dispatcher.
 *
 * Service identifier: `TRAINING_CONFIG_SERVICE` (`"training_config_service"`).
 */

import {
  type IAgentRuntime,
  Service,
  type ServiceTypeName,
} from "@elizaos/core";
import {
  loadTrainingConfig as defaultLoadTrainingConfig,
  saveTrainingConfig as defaultSaveTrainingConfig,
  type TrainingConfig,
} from "../core/training-config.js";

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    TRAINING_CONFIG_SERVICE: "training_config_service";
  }
}

export const TRAINING_CONFIG_SERVICE =
  "training_config_service" as ServiceTypeName;

/** Input the host passes after validating the SETTINGS `toggle_training` op. */
export interface AutoTrainToggleInput {
  /** Enable or disable auto-training. */
  enabled: boolean;
  /** Optional new trigger threshold (trajectories per task). Floored on write. */
  threshold?: number;
  /** Optional new cooldown, in hours, between runs for the same task. */
  cooldownHours?: number;
}

/**
 * The three fields the host echoes back to the caller. Kept minimal on purpose
 * — the host neither needs nor should know the full {@link TrainingConfig}
 * shape.
 */
export interface TrainingConfigSummary {
  autoTrain: boolean;
  triggerThreshold: number;
  triggerCooldownHours: number;
}

export interface TrainingConfigServiceOptions {
  loadConfig?: () => TrainingConfig;
  saveConfig?: (config: TrainingConfig) => void;
}

/**
 * Structural contract the host depends on (it looks the service up by name and
 * calls `applyAutoTrainToggle`). Declared here so the host can restate the same
 * shape locally without importing this plugin.
 */
export interface TrainingConfigCapability {
  applyAutoTrainToggle(input: AutoTrainToggleInput): TrainingConfigSummary;
}

export class TrainingConfigService
  extends Service
  implements TrainingConfigCapability
{
  static serviceType = TRAINING_CONFIG_SERVICE;

  readonly capabilityDescription =
    "Reads and mutates the auto-training config for the host SETTINGS toggle_training op.";

  private readonly loadConfig: () => TrainingConfig;
  private readonly saveConfig: (config: TrainingConfig) => void;

  constructor(
    runtime?: IAgentRuntime,
    options: TrainingConfigServiceOptions = {},
  ) {
    super(runtime);
    this.loadConfig = options.loadConfig ?? defaultLoadTrainingConfig;
    this.saveConfig = options.saveConfig ?? defaultSaveTrainingConfig;
  }

  async stop(): Promise<void> {}

  /**
   * Merge the toggle over the persisted config, persist it, and return the
   * summary the host echoes. Trusts pre-validated input (presence/type checks
   * happen at the route/action layer).
   */
  applyAutoTrainToggle(input: AutoTrainToggleInput): TrainingConfigSummary {
    const current = this.loadConfig();
    const next: TrainingConfig = {
      ...current,
      autoTrain: input.enabled,
      ...(typeof input.threshold === "number"
        ? { triggerThreshold: Math.floor(input.threshold) }
        : {}),
      ...(typeof input.cooldownHours === "number"
        ? { triggerCooldownHours: input.cooldownHours }
        : {}),
    };
    this.saveConfig(next);
    return {
      autoTrain: next.autoTrain,
      triggerThreshold: next.triggerThreshold,
      triggerCooldownHours: next.triggerCooldownHours,
    };
  }
}

/** Register (or replace) the TrainingConfigService on the runtime service map. */
export function registerTrainingConfigService(
  runtime: IAgentRuntime,
  options: TrainingConfigServiceOptions = {},
): TrainingConfigService {
  const service = new TrainingConfigService(runtime, options);
  runtime.services.set(TRAINING_CONFIG_SERVICE, [service]);
  return service;
}
