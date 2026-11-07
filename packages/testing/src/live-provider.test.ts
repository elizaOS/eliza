import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectLiveProvider } from "./live-provider.ts";

let directory: string;
let config: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "test-provider-config-"));
  config = path.join(directory, "eliza.json");
  for (const name of [
    "OPENAI_API_KEY",
    "CEREBRAS_API_KEY",
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZA_CLOUD_API_KEY",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("ELIZA_CONFIG_PATH", config);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("reads changed provider configuration instead of retaining a previous account key", () => {
  writeFileSync(
    config,
    JSON.stringify({ cloud: { apiKey: "fixture-account-one" } }),
  );
  expect(selectLiveProvider("openai")?.apiKey).toBe("fixture-account-one");
  writeFileSync(
    config,
    JSON.stringify({ cloud: { apiKey: "fixture-account-two" } }),
  );
  expect(selectLiveProvider("openai")?.apiKey).toBe("fixture-account-two");
});

it("distinguishes an absent configuration from malformed or unreadable configuration", () => {
  expect(selectLiveProvider("openai")).toBeNull();
  writeFileSync(config, "{");
  expect(() => selectLiveProvider("openai")).toThrow(
    expect.objectContaining({ code: "TEST_PROVIDER_CONFIG_INVALID" }),
  );
  vi.stubEnv("ELIZA_CONFIG_PATH", directory);
  expect(() => selectLiveProvider("openai")).toThrow(
    expect.objectContaining({ code: "TEST_PROVIDER_CONFIG_INVALID" }),
  );
});
