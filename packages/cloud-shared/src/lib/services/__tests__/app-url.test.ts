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
});
