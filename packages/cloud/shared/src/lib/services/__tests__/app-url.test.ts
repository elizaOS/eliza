// Exercises app url behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { deriveAppPublicUrl, deriveManagedFrontendPublicUrl } from "../app-url";

const BASE = "CONTAINERS_PUBLIC_BASE_DOMAIN";
const FALLBACK = "ELIZA_CLOUD_AGENT_BASE_DOMAIN";
const prevBase = process.env[BASE];
const prevFallback = process.env[FALLBACK];

function restore(key: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

afterEach(() => {
  restore(BASE, prevBase);
  restore(FALLBACK, prevFallback);
});

const CID = "aabbccdd-1111-4222-8333-444455556666";

describe("deriveAppPublicUrl", () => {
  test("derives <shortid>.<base> hostname + https url when a base domain is set", () => {
    process.env[BASE] = "containers.elizacloud.ai";
    expect(deriveAppPublicUrl(CID)).toEqual({
      hostname: "aabbccdd.containers.elizacloud.ai",
      url: "https://aabbccdd.containers.elizacloud.ai",
    });
  });

  test("returns null when no public base domain is configured (e.g. local dev)", () => {
    delete process.env[BASE];
    delete process.env[FALLBACK];
    expect(deriveAppPublicUrl(CID)).toBeNull();
  });

  test("does NOT inherit the agent sandbox domain — null when only the agent domain is set", () => {
    // Regression: apps must never silently land on the agent sandbox domain just
    // because they ran on a host that has ELIZA_CLOUD_AGENT_BASE_DOMAIN set.
    delete process.env[BASE];
    process.env[FALLBACK] = "example.ai";
    expect(deriveAppPublicUrl(CID)).toBeNull();
  });

  test("uses the apps base domain (apps.elizacloud.ai) when set, ignoring the agent domain", () => {
    process.env[BASE] = "apps.elizacloud.ai";
    process.env[FALLBACK] = "example.ai";
    expect(deriveAppPublicUrl(CID)).toEqual({
      hostname: "aabbccdd.apps.elizacloud.ai",
      url: "https://aabbccdd.apps.elizacloud.ai",
    });
  });
});

describe("deriveManagedFrontendPublicUrl", () => {
  test("uses the stable project slug under the configured frontend suffix", () => {
    expect(deriveManagedFrontendPublicUrl("Habit-Tracker", ".sites.elizacloud.ai.")).toEqual({
      hostname: "habit-tracker.sites.elizacloud.ai",
      url: "https://habit-tracker.sites.elizacloud.ai",
    });
  });

  test("returns null when the operator suffix is absent", () => {
    expect(deriveManagedFrontendPublicUrl("habit-tracker", undefined)).toBeNull();
  });

  test("rejects malformed slugs and suffixes instead of constructing a URL", () => {
    expect(deriveManagedFrontendPublicUrl("two.labels", "sites.elizacloud.ai")).toBeNull();
    expect(deriveManagedFrontendPublicUrl("habit-tracker", "localhost")).toBeNull();
    const label = "a".repeat(63);
    expect(
      deriveManagedFrontendPublicUrl("habit-tracker", `${label}.${label}.${label}.${label}.ai`),
    ).toBeNull();
  });
});
