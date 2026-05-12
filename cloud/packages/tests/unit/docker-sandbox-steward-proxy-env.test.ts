import { describe, expect, test } from "bun:test";
import { buildStewardProxyEnv } from "@/lib/services/docker-sandbox-provider";

describe("buildStewardProxyEnv", () => {
  test("returns empty object when USE_STEWARD_PROXY is unset", () => {
    expect(buildStewardProxyEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });

  test("returns empty object when USE_STEWARD_PROXY is not 'true'", () => {
    expect(buildStewardProxyEnv({ USE_STEWARD_PROXY: "false" } as NodeJS.ProcessEnv)).toEqual({});
    expect(buildStewardProxyEnv({ USE_STEWARD_PROXY: "1" } as NodeJS.ProcessEnv)).toEqual({});
    expect(buildStewardProxyEnv({ USE_STEWARD_PROXY: "" } as NodeJS.ProcessEnv)).toEqual({});
  });

  test("emits all proxy + RPC URLs when USE_STEWARD_PROXY=true", () => {
    const result = buildStewardProxyEnv({
      USE_STEWARD_PROXY: "true",
    } as NodeJS.ProcessEnv);
    expect(result).toEqual({
      STEWARD_PROXY_URL: "http://host.docker.internal:8080",
      OPENAI_BASE_URL: "http://host.docker.internal:8080/openai/v1",
      ANTHROPIC_BASE_URL: "http://host.docker.internal:8080/anthropic",
      BSC_RPC_URL: "https://bsc-dataseed.binance.org",
      BASE_RPC_URL: "https://mainnet.base.org",
      ETHEREUM_RPC_URL: "https://eth.llamarpc.com",
    });
  });

  test("emits keys that survive the env validator (UPPER_SNAKE_CASE)", () => {
    const result = buildStewardProxyEnv({
      USE_STEWARD_PROXY: "true",
    } as NodeJS.ProcessEnv);
    for (const key of Object.keys(result)) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("does not mutate the input env", () => {
    const input = { USE_STEWARD_PROXY: "true" } as NodeJS.ProcessEnv;
    const snapshot = { ...input };
    buildStewardProxyEnv(input);
    expect(input).toEqual(snapshot);
  });
});
