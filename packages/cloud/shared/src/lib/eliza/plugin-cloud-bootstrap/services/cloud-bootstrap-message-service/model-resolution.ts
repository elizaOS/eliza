/**
 * Per-step model resolution + entity-settings overrides.
 *
 * Cloud lets operators pin specific models to the shouldRespond,
 * planner, and response steps. The resolution chain falls back from
 * the most-specific setting (`ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL`) to
 * the size tier (`ELIZAOS_CLOUD_NANO_MODEL`, etc.) to the generic
 * `SMALL_MODEL` / `LARGE_MODEL`. Overrides are scoped to the current
 * request via the request-context entity settings map.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { getRequestContext } from "../../../../services/entity-settings/request-context";
import type { ScopedSettingOverride } from "./types";

function readTrimmedSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveNanoModel(runtime: IAgentRuntime): string | undefined {
  return readTrimmedSetting(runtime, "ELIZAOS_CLOUD_NANO_MODEL");
}

function resolveMediumModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_MEDIUM_MODEL") ||
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ||
    readTrimmedSetting(runtime, "SMALL_MODEL")
  );
}

function resolveSmallModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ||
    readTrimmedSetting(runtime, "SMALL_MODEL")
  );
}

function resolveLargeModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_LARGE_MODEL") ||
    readTrimmedSetting(runtime, "LARGE_MODEL")
  );
}

export function resolveShouldRespondStepModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL") ||
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL") ||
    resolveNanoModel(runtime) ||
    resolveSmallModel(runtime)
  );
}

export function resolveActionPlannerStepModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL") ||
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_PLANNER_MODEL") ||
    resolveMediumModel(runtime) ||
    resolveSmallModel(runtime)
  );
}

export function resolveResponseStepModel(runtime: IAgentRuntime): string | undefined {
  return readTrimmedSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_MODEL") || resolveLargeModel(runtime);
}

export async function withScopedSettings<T>(
  overrides: ScopedSettingOverride[],
  operation: () => Promise<T>,
): Promise<T> {
  const requestContext = getRequestContext();
  if (!requestContext || overrides.length === 0) {
    return await operation();
  }

  const previousValues = new Map<
    string,
    { hadValue: boolean; value: string | boolean | number | null | undefined }
  >();

  for (const override of overrides) {
    previousValues.set(override.key, {
      hadValue: requestContext.entitySettings.has(override.key),
      value: requestContext.entitySettings.get(override.key),
    });
    requestContext.entitySettings.set(override.key, override.value);
  }

  try {
    return await operation();
  } finally {
    for (const override of overrides) {
      const previous = previousValues.get(override.key);
      if (!previous) {
        continue;
      }
      if (previous.hadValue) {
        requestContext.entitySettings.set(override.key, previous.value ?? null);
      } else {
        requestContext.entitySettings.delete(override.key);
      }
    }
  }
}

export async function withScopedTextModel<T>(
  size: "small" | "large",
  model: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!model) {
    return await operation();
  }

  const overrides =
    size === "small"
      ? [
          { key: "ELIZAOS_CLOUD_SMALL_MODEL", value: model },
          { key: "SMALL_MODEL", value: model },
        ]
      : [
          { key: "ELIZAOS_CLOUD_LARGE_MODEL", value: model },
          { key: "LARGE_MODEL", value: model },
        ];

  return await withScopedSettings(overrides, operation);
}
