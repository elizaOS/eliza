/**
 * Configuration Validator
 *
 * Validates RL pipeline configuration before execution.
 */

import type { BenchmarkConfig } from "../benchmark/BenchmarkDataGenerator";
import { logger } from "../utils/logger";

export interface TrainingConfig {
  min_trajectories_per_batch: number;
  batch_size: number;
  learning_rate: number;
  kl_penalty: number;
  iterations_per_window: number;
  warmup_steps: number;
  max_grad_norm: number;
  gamma: number;
}

/**
 * Shared validation result type for configuration validation.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate training configuration
 */
export function validateTrainingConfig(
  config: TrainingConfig,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate batch size
  if (config.batch_size <= 0) {
    errors.push("batch_size must be greater than 0");
  }
  if (config.batch_size > 64) {
    warnings.push("batch_size > 64 may cause memory issues");
  }

  // Validate learning rate
  if (config.learning_rate <= 0) {
    errors.push("learning_rate must be greater than 0");
  }
  if (config.learning_rate > 1e-3) {
    warnings.push("learning_rate > 1e-3 may cause training instability");
  }
  if (config.learning_rate < 1e-8) {
    warnings.push(
      "learning_rate < 1e-8 may be too small for effective learning",
    );
  }

  // Validate KL penalty
  if (config.kl_penalty < 0) {
    errors.push("kl_penalty must be non-negative");
  }
  if (config.kl_penalty > 1.0) {
    warnings.push("kl_penalty > 1.0 may be too high");
  }

  // Validate iterations
  if (config.iterations_per_window <= 0) {
    errors.push("iterations_per_window must be greater than 0");
  }

  // Validate warmup steps
  if (config.warmup_steps < 0) {
    errors.push("warmup_steps must be non-negative");
  }

  // Validate max grad norm
  if (config.max_grad_norm <= 0) {
    errors.push("max_grad_norm must be greater than 0");
  }

  // Validate gamma
  if (config.gamma < 0 || config.gamma > 1) {
    errors.push("gamma must be between 0 and 1");
  }

  // Validate min trajectories
  if (config.min_trajectories_per_batch <= 0) {
    errors.push("min_trajectories_per_batch must be greater than 0");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate benchmark configuration
 */
export function validateBenchmarkConfig(config: {
  duration_minutes: number;
  tick_interval_seconds: number;
  num_prediction_markets: number;
  num_perpetual_markets: number;
}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.duration_minutes <= 0) {
    errors.push("duration_minutes must be greater than 0");
  }
  if (config.duration_minutes > 10080) {
    warnings.push(
      "duration_minutes > 10080 (1 week) may take a long time to generate",
    );
  }

  if (config.tick_interval_seconds <= 0) {
    errors.push("tick_interval_seconds must be greater than 0");
  }

  if (config.num_prediction_markets <= 0) {
    errors.push("num_prediction_markets must be greater than 0");
  }

  if (config.num_perpetual_markets <= 0) {
    errors.push("num_perpetual_markets must be greater than 0");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate full pipeline config
 */
export function validatePipelineConfig(config: {
  benchmark: BenchmarkConfig | null | undefined;
  training: TrainingConfig;
  agents: { test_agent_count: number };
}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate benchmark config
  if (config.benchmark) {
    const benchmarkResult = validateBenchmarkConfig({
      duration_minutes: config.benchmark.durationMinutes,
      tick_interval_seconds: config.benchmark.tickInterval,
      num_prediction_markets: config.benchmark.numPredictionMarkets,
      num_perpetual_markets: config.benchmark.numPerpetualMarkets,
    });
    errors.push(...benchmarkResult.errors);
    warnings.push(...benchmarkResult.warnings);
  }

  // Validate training config
  if (config.training) {
    const trainingResult = validateTrainingConfig(config.training);
    errors.push(...trainingResult.errors);
    warnings.push(...trainingResult.warnings);
  }

  // Validate agent config
  if (config.agents.test_agent_count <= 0) {
    errors.push("test_agent_count must be greater than 0");
  }
  if (config.agents.test_agent_count > 10) {
    warnings.push("test_agent_count > 10 may be slow");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate and log results
 */
export function validateAndLog(config: {
  benchmark: BenchmarkConfig | null | undefined;
  training: TrainingConfig;
  agents: { test_agent_count: number };
}): boolean {
  const result = validatePipelineConfig(config);

  if (result.warnings.length > 0) {
    logger.warn(
      "Configuration warnings",
      { warnings: result.warnings },
      "ConfigValidator",
    );
    result.warnings.forEach((w) => {
      console.log(`  ⚠️  ${w}`);
    });
  }

  if (result.errors.length > 0) {
    logger.error(
      "Configuration errors",
      { errors: result.errors },
      "ConfigValidator",
    );
    result.errors.forEach((e) => {
      console.error(`  ❌ ${e}`);
    });
    return false;
  }

  logger.info(
    "Configuration validation passed",
    undefined,
    "ConfigValidator",
  );
  return true;
}

/** @deprecated Use standalone functions instead */
export const ConfigValidator = {
  validateTrainingConfig,
  validateBenchmarkConfig,
  validatePipelineConfig,
  validateAndLog,
};
