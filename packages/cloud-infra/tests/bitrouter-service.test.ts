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
    expect(dockerfile).toContain('CMD ["/app/entrypoint.sh"]');
    expect(entrypoint).toContain(
      "bitrouter serve --config-file /app/bitrouter.yaml",
    );
    expect(entrypoint).toContain("bitrouter wallet create --name eliza-cloud");
    expect(entrypoint).toContain("bitrouter key sign --wallet eliza-cloud");
    expect(entrypoint).toContain("exec node /app/auth-proxy.mjs");
    expect(proxy).toContain("BITROUTER_PROXY_TOKEN");
    expect(proxy).toContain("BITROUTER_INTERNAL_JWT_FILE");
    expect(proxy).toContain("bitrouter_proxy_usage_cost");
    expect(proxy).toContain('"gpt-oss-120b", { input: 0.35, output: 0.75 }');
    expect(proxy).toContain('"zai-glm-4.7", { input: 2.25, output: 2.75 }');
    expect(proxy).toContain("header === `Bearer $");
    expect(proxy).toContain(
      'headers.set("authorization", getInternalAuthorization())',
    );
    expect(proxy).toContain("fetch(target");
  });

  test("keeps BitRouter local-only and exposes Railway healthcheck through proxy", () => {
    const config = parseYaml(readBitRouterFile("bitrouter.yaml")) as {
      server: { listen: string };
      database: { url: string };
      providers: Record<
        string,
        {
          api_protocol?: string;
          models?: Record<
            string,
            {
              pricing?: {
                input_tokens?: { no_cache?: number };
                output_tokens?: { text?: number };
              };
            }
          >;
        }
      >;
      models: Record<
        string,
        {
          endpoints: Array<{ provider: string; service_id: string }>;
          pricing?: {
            input_tokens?: { no_cache?: number };
            output_tokens?: { text?: number };
          };
        }
      >;
    };
    const railway = readBitRouterFile("railway.toml");

    expect(config.server.listen).toBe("127.0.0.1:4356");
    expect(config.database.url).toBe("sqlite:/data/bitrouter.db");
    expect(config.providers).toHaveProperty("bitrouter");
    expect(config.providers.cerebras?.api_protocol).toBe("openai");
    expect(
      config.providers.cerebras?.models?.["gpt-oss-120b"]?.pricing,
    ).toEqual({
      input_tokens: { no_cache: 0.35, cache_read: 0.35, cache_write: 0.35 },
      output_tokens: { text: 0.75, reasoning: 0 },
    });
    expect(config.providers.cerebras?.models?.["zai-glm-4.7"]?.pricing).toEqual(
      {
        input_tokens: { no_cache: 2.25, cache_read: 2.25, cache_write: 2.25 },
        output_tokens: { text: 2.75, reasoning: 0 },
      },
    );
    for (const route of ["gpt-oss-120b", "cerebras:gpt-oss-120b"]) {
      expect(config.models[route]?.endpoints).toContainEqual({
        provider: "cerebras",
        service_id: "gpt-oss-120b",
      });
      expect(config.models[route]?.pricing).toEqual({
        input_tokens: { no_cache: 0.35, cache_read: 0.35, cache_write: 0.35 },
        output_tokens: { text: 0.75, reasoning: 0 },
      });
    }
    for (const route of ["zai-glm-4.7", "cerebras:zai-glm-4.7"]) {
      expect(config.models[route]?.endpoints).toContainEqual({
        provider: "cerebras",
        service_id: "zai-glm-4.7",
      });
      expect(config.models[route]?.pricing).toEqual({
        input_tokens: { no_cache: 2.25, cache_read: 2.25, cache_write: 2.25 },
        output_tokens: { text: 2.75, reasoning: 0 },
      });
    }
    expect(railway).toContain("[deploy]");
    expect(railway).toContain('healthcheckPath = "/health"');
  });
});
