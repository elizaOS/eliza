/**
 * Readiness-aware, per-runtime LifeOps schema bootstrap shared by registry-only
 * startup and HTTP route boundaries. Concurrent callers share one migration;
 * failed attempts are evicted so a later request can retry the real failure.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "./repository.js";

const lifeOpsSchemaBootstraps = new WeakMap<IAgentRuntime, Promise<void>>();

export async function ensureLifeOpsSchema(
  runtime: IAgentRuntime | null,
): Promise<void> {
  if (!runtime) return;

  // Do not memoize a no-op while the database is still coming online. The
  // post-ready hook normally reaches this with a live adapter, while route
  // callers remain a safe retry boundary during startup and repair boots.
  const adapter = runtime.adapter;
  if (!adapter || typeof adapter.runPluginMigrations !== "function") return;
  if (typeof adapter.isReady === "function" && !(await adapter.isReady())) {
    return;
  }

  let bootstrap = lifeOpsSchemaBootstraps.get(runtime);
  if (!bootstrap) {
    const pending = LifeOpsRepository.bootstrapSchema(runtime);
    lifeOpsSchemaBootstraps.set(runtime, pending);
    // error-policy:J5 the rejection is observed by `await bootstrap` below;
    // this observer only evicts the failed attempt so a later request retries.
    void pending.catch(() => {
      if (lifeOpsSchemaBootstraps.get(runtime) === pending) {
        lifeOpsSchemaBootstraps.delete(runtime);
      }
    });
    bootstrap = pending;
  }
  await bootstrap;
}
