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
    expect(dockerfile).toContain('grep -q "buffer-v2"');
    expect(dockerfile).toContain('grep -q "openrouter:"');
    expect(dockerfile).toContain(
      'grep -q "api_protocol: openai"',
    );
    expect(dockerfile).toContain('grep -q "no_cache: 0.039"');
    expect(dockerfile).toContain('grep -q "no_cache: 0.35"');
    expect(dockerfile).toContain('grep -q "no_cache: 2.25"');
    expect(dockerfile).toContain('CMD ["/app/entrypoint.sh"]');
    expect(entrypoint).toContain(
      "bitrouter serve --config-file /app/bitrouter.yaml",
    );
    expect(entrypoint).toContain("BITROUTER_OPENROUTER_API_KEY");
    expect(entrypoint).toContain("OPENROUTER_API_KEY");
    expect(entrypoint).toContain("bitrouter wallet create --name eliza-cloud");
    expect(entrypoint).toContain("bitrouter key sign --wallet eliza-cloud");
    expect(entrypoint).toContain("exec node /app/auth-proxy.mjs");
    expect(proxy).toContain("BITROUTER_PROXY_TOKEN");
    expect(proxy).toContain("BITROUTER_INTERNAL_JWT_FILE");
    expect(proxy).toContain("bitrouter_proxy_usage_cost");
    expect(proxy).toContain('const auditMode = "buffer-v2"');
    expect(proxy).toContain("cerebras-zai-glm-4.7-token-floor");
    expect(proxy).toContain("prepareChatCompletionRequest");
    expect(proxy).toContain('requestedModel === "zai-glm-4.7"');
    expect(proxy).toContain('parsed.reasoning_effort = "none"');
    expect(proxy).toContain("parsed.max_tokens = 256");
    expect(proxy).toContain(
      '"gpt-oss-120b", { input: 0.35, cacheRead: 0, cacheWrite: 0, output: 0.75 }',
    );
    expect(proxy).toContain(
      '"zai-glm-4.7", { input: 2.25, cacheRead: 0, cacheWrite: 0, output: 2.75 }',
    );
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
    };
    const railway = readBitRouterFile("railway.toml");

    expect(config.server.listen).toBe("127.0.0.1:4356");
    expect(config.database.url).toBe("sqlite:/data/bitrouter.db");
    expect(config.providers).toHaveProperty("bitrouter");
    expect(config.providers).toHaveProperty("openrouter");
    expect(
      config.providers.openrouter?.models?.["openai/gpt-oss-120b"]?.pricing,
    ).toEqual({
      input_tokens: { no_cache: 0.039, cache_read: 0, cache_write: 0 },
      output_tokens: { text: 0.18, reasoning: 0 },
    });
    expect(config.providers.cerebras?.api_protocol).toBe("openai");
    expect(
      config.providers.cerebras?.models?.["gpt-oss-120b"]?.pricing,
    ).toEqual({
      input_tokens: { no_cache: 0.35, cache_read: 0, cache_write: 0 },
      output_tokens: { text: 0.75, reasoning: 0 },
    });
    expect(
      config.providers.cerebras?.models?.["zai-glm-4.7"]?.pricing,
    ).toEqual({
      input_tokens: { no_cache: 2.25, cache_read: 0, cache_write: 0 },
      output_tokens: { text: 2.75, reasoning: 0 },
    });
    expect(config).not.toHaveProperty("models");
    expect(railway).toContain("[deploy]");
    expect(railway).toContain('healthcheckPath = "/health"');
  });
});
