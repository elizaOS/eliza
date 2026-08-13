/**
 * Locks the deferred boot phase boundary that makes core services available
 * before feature-plugin start hooks execute. Exact live-boot evidence covers
 * the runtime behavior; this focused contract prevents the two awaited phases
 * from being reordered without an explicit test failure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaSource = readFileSync(path.join(here, "eliza.ts"), "utf8");

function extractRunDeferredBootBody(source: string): string {
  const marker = "const runDeferredBoot = async (";
  const start = source.indexOf(marker);
  expect(start, "runDeferredBoot closure must exist").toBeGreaterThan(-1);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }

  throw new Error("Could not find the end of runDeferredBoot");
}

function extractDeferredRegistrationBody(source: string): string {
  const marker = "const registerDeferredRuntimePlugins = async (";
  const start = source.indexOf(marker);
  expect(start, "deferred registration closure must exist").toBeGreaterThan(-1);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }

  throw new Error("Could not find the end of registerDeferredRuntimePlugins");
}

describe("deferred plugin boot ordering", () => {
  it("registers core services before feature plugins", () => {
    const body = extractRunDeferredBootBody(elizaSource);
    const coreWaveIndex = body.indexOf(
      "await preregisterCorePluginsInDependencyWaves({",
    );
    const featureWaveIndex = body.indexOf(
      "await registerDeferredRuntimePlugins(",
    );

    expect(coreWaveIndex, "core registration phase must run").toBeGreaterThan(
      -1,
    );
    expect(
      featureWaveIndex,
      "feature registration phase must run",
    ).toBeGreaterThan(-1);
    expect(coreWaveIndex).toBeLessThan(featureWaveIndex);
  });

  it("keeps timed registrations observed until their definitive result", () => {
    const body = extractDeferredRegistrationBody(elizaSource);

    expect(body).toContain("await runtime.registerPlugin(plugin)");
    expect(body).toContain("registrationWatchdog = setTimeout");
    expect(body).toContain(
      "const timeoutMs = resolveDeferredPluginRegistrationTimeoutMs()",
    );
    expect(body).not.toContain("Promise.race([");
    expect(body).not.toContain("Math.max(timeoutMs, 60_000)");
  });

  it("starts the preferred provider in the shared worker queue", () => {
    const body = extractDeferredRegistrationBody(elizaSource);
    const queueIndex = body.indexOf(
      "const registrationQueue = preferredPlugin",
    );
    const workersIndex = body.indexOf("await Promise.all(");

    expect(queueIndex).toBeGreaterThan(-1);
    expect(workersIndex).toBeGreaterThan(queueIndex);
    expect(body).not.toContain(
      "await registerDeferredPlugin(\n        preferredPlugin",
    );
  });
});
