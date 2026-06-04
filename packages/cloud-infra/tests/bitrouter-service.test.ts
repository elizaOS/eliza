import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const BITROUTER_DIR = join(import.meta.dir, "..", "cloud", "bitrouter");

function readBitRouterFile(file: string): string {
  return readFileSync(join(BITROUTER_DIR, file), "utf-8");
}

describe("BitRouter Railway service", () => {
  test("runs BitRouter behind the authenticated proxy", () => {
    const dockerfile = readBitRouterFile("Dockerfile");
    const entrypoint = readBitRouterFile("entrypoint.sh");
    const proxy = readBitRouterFile("auth-proxy.mjs");

    expect(dockerfile).toContain("npm install -g bitrouter");
    expect(dockerfile).toContain("expect");
    expect(dockerfile).toContain("CMD [\"/app/entrypoint.sh\"]");
    expect(entrypoint).toContain("bitrouter serve --config-file /app/bitrouter.yaml");
    expect(entrypoint).toContain("bitrouter wallet create --name eliza-cloud");
    expect(entrypoint).toContain("bitrouter key sign --wallet eliza-cloud");
    expect(entrypoint).toContain("exec node /app/auth-proxy.mjs");
    expect(proxy).toContain("BITROUTER_PROXY_TOKEN");
    expect(proxy).toContain("BITROUTER_INTERNAL_JWT_FILE");
    expect(proxy).toContain('proxyVersion = "forced-provider-v1"');
    expect(proxy).toContain("header === `Bearer ${token}`");
    expect(proxy).toContain('prefix: "openrouter:"');
    expect(proxy).toContain('prefix: "cerebras:"');
    expect(proxy).toContain('body.reasoning_effort = "none"');
    expect(proxy).toContain('headers.set("authorization", getInternalAuthorization())');
    expect(proxy).toContain("fetch(target");
  });

  test("keeps BitRouter local-only and exposes Railway healthcheck through proxy", () => {
    const config = parseYaml(readBitRouterFile("bitrouter.yaml")) as {
      server: { listen: string };
      database: { url: string };
      providers: Record<string, unknown> & {
        cerebras?: {
          api_protocol?: string;
          models?: Array<{
            id?: string;
            pricing?: {
              input_micro_usd_per_token?: number;
              output_micro_usd_per_token?: number;
            };
          }>;
        };
        openrouter?: Record<string, unknown>;
      };
    };
    const railway = readBitRouterFile("railway.toml");

    expect(config.server.listen).toBe("127.0.0.1:4356");
    expect(config.database.url).toBe("sqlite:/data/bitrouter.db");
    expect(config.providers).toHaveProperty("bitrouter");
    expect(config.providers.openrouter).toEqual({});
    expect(config.providers.cerebras?.api_protocol).toBe("chat_completions");
    expect(config.providers.cerebras?.models?.map((model) => model.id)).toEqual([
      "gpt-oss-120b",
      "zai-glm-4.7",
    ]);
    expect(config.providers.cerebras?.models?.[0]?.pricing).toEqual({
      input_micro_usd_per_token: 0.35,
      output_micro_usd_per_token: 0.75,
    });
    expect(config.providers.cerebras?.models?.[1]?.pricing).toEqual({
      input_micro_usd_per_token: 2.25,
      output_micro_usd_per_token: 2.75,
    });
    expect(railway).toContain('[deploy]');
    expect(railway).toContain('healthcheckPath = "/health"');
  });
});
