import { afterEach, describe, expect, test } from "bun:test";
import { deriveAppPublicUrl } from "../app-url";

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
    // Regression: apps must never silently land on the agent/milady domain just
    // because they ran on a host that has ELIZA_CLOUD_AGENT_BASE_DOMAIN set.
    delete process.env[BASE];
    process.env[FALLBACK] = "milady.ai";
    expect(deriveAppPublicUrl(CID)).toBeNull();
  });

  test("uses the apps base domain (apps.elizacloud.ai) when set, ignoring the agent domain", () => {
    process.env[BASE] = "apps.elizacloud.ai";
    process.env[FALLBACK] = "milady.ai";
    expect(deriveAppPublicUrl(CID)).toEqual({
      hostname: "aabbccdd.apps.elizacloud.ai",
      url: "https://aabbccdd.apps.elizacloud.ai",
    });
  });
});
