/**
 * Built-in health checks used by the runtime-operations health gate.
 *
 * Each check is a small, self-contained `HealthCheck`. The `HealthChecker`
 * (in `health.ts`) runs them in parallel with per-check timeouts; required
 * checks block promotion of a new/re-initialised runtime.
 *
 * Conventions:
 *   - No shared mutable state across checks.
 *   - Logger only (`[runtime-ops:health-checks]`).
 *   - Treat optional/missing runtime surface as "not applicable, ok".
 *   - Treat real failures (DB ping false, provider unreachable) as failures.
 */

import { type AgentRuntime, logger, ModelType } from "@elizaos/core";
import { isInsufficientCreditsError } from "../../api/credit-detection.js";
import type { HealthCheck, HealthCheckResult } from "./types.js";

const LOG_PREFIX = "[runtime-ops:health-checks]";

// ---------------------------------------------------------------------------
// Runtime guards — keep us off `any` while accommodating partial typings.
// ---------------------------------------------------------------------------

interface DbAdapterLike {
  isReady?: () => Promise<boolean>;
}

interface ServiceRegistryLike {
  getRegisteredServiceTypes?: () => readonly string[];
  getServiceRegistrationStatus?: (
    serviceType: string,
  ) => "pending" | "registering" | "registered" | "failed" | "unknown";
}

function getDbAdapter(runtime: AgentRuntime): DbAdapterLike | null {
  const adapter = runtime.adapter;
  if (adapter == null || typeof adapter !== "object") return null;
  return adapter as DbAdapterLike;
}

function asServiceRegistry(runtime: AgentRuntime): ServiceRegistryLike {
  return runtime as AgentRuntime & ServiceRegistryLike;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// runtimeReadyCheck — character + agentId populated.
// ---------------------------------------------------------------------------

export const runtimeReadyCheck: HealthCheck = {
  name: "runtime-ready",
  required: true,
  timeoutMs: 1000,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    if (!runtime || typeof runtime !== "object") {
      return { ok: false, reason: "runtime is not an object" };
    }
    const agentId = runtime.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) {
      return { ok: false, reason: "runtime.agentId is empty" };
    }
    const character = runtime.character;
    if (!character || typeof character !== "object") {
      return { ok: false, reason: "runtime.character is missing" };
    }
    const name =
      typeof character.name === "string" ? character.name.trim() : "";
    if (name.length === 0) {
      return { ok: false, reason: "runtime.character.name is empty" };
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// essentialServicesCheck — no registered service is in a failed state.
// ---------------------------------------------------------------------------

export const essentialServicesCheck: HealthCheck = {
  name: "essential-services",
  required: true,
  timeoutMs: 2000,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    const reg = asServiceRegistry(runtime);
    if (typeof reg.getRegisteredServiceTypes !== "function") {
      // Older runtime build without the enumeration API. Cannot enforce
      // anything reliably — silent pass beats a wrong fail.
      logger.debug(
        `${LOG_PREFIX} runtime.getRegisteredServiceTypes unavailable; skipping`,
      );
      return { ok: true };
    }

    const types = reg.getRegisteredServiceTypes();
    if (!Array.isArray(types) || types.length === 0) {
      return { ok: true };
    }

    if (typeof reg.getServiceRegistrationStatus !== "function") {
      return { ok: true };
    }

    for (const type of types) {
      const status = reg.getServiceRegistrationStatus(type);
      if (status === "failed") {
        return {
          ok: false,
          reason: `service ${type} is in failed state`,
        };
      }
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// dbConnectionCheck — adapter.isReady() returns true (when adapter exists).
// ---------------------------------------------------------------------------

export const dbConnectionCheck: HealthCheck = {
  name: "db-connection",
  required: true,
  timeoutMs: 1500,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    const adapter = getDbAdapter(runtime);
    if (!adapter) {
      // Runtime without a database adapter (rare but supported) — pass.
      return { ok: true };
    }
    if (typeof adapter.isReady !== "function") {
      // Older adapter without isReady — best-effort pass; don't block on
      // a missing API surface we cannot probe.
      return { ok: true };
    }
    try {
      const ready = await adapter.isReady();
      if (ready === true) return { ok: true };
      return { ok: false, reason: "adapter.isReady() returned false" };
    } catch (err) {
      return {
        ok: false,
        reason: `adapter.isReady() threw: ${describeError(err)}`,
        cause: err,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// providerSmokeCheck — minimal useModel call to confirm the provider
// pipeline is wired and reachable.
// ---------------------------------------------------------------------------

export const providerSmokeCheck: HealthCheck = {
  name: "provider-smoke",
  required: true,
  timeoutMs: 5000,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    if (typeof runtime.useModel !== "function") {
      // Older / stripped runtime — no model surface to probe.
      return { ok: true };
    }
    try {
      // Tiny, deterministic prompt with a hard 1-token cap. Empty completions
      // still count as "model responded" — we only need transport health.
      await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "ping",
        maxTokens: 1,
        temperature: 0,
      });
      return { ok: true };
    } catch (err) {
      if (isInsufficientCreditsError(err)) {
        return {
          ok: false,
          reason: "provider quota exhausted",
          cause: err,
        };
      }
      const name = err instanceof Error ? err.name : "";
      // The AI SDK throws AI_NoOutputGeneratedError when the model returned
      // zero tokens. That's still a healthy transport: the request reached
      // the provider, the provider replied, just with no text. Treat as ok.
      if (name === "AI_NoOutputGeneratedError") {
        return { ok: true };
      }
      return {
        ok: false,
        reason: `provider unreachable: ${describeError(err)}`,
        cause: err,
      };
    }
  },
};

/**
 * The full set of built-in checks pre-registered by the default checker.
 * Order is not significant — checks run in parallel.
 */
export const builtInHealthChecks: readonly HealthCheck[] = [
  runtimeReadyCheck,
  essentialServicesCheck,
  dbConnectionCheck,
  providerSmokeCheck,
];
