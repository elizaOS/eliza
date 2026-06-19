import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const BITROUTER_DIR = join(import.meta.dir, "..", "cloud", "bitrouter");

function readBitRouterFile(file: string): string {
  return readFileSync(join(BITROUTER_DIR, file), "utf-8");
}

function expectEndpointChain(
  models: Record<
    string,
    { endpoints?: Array<{ provider?: string; service_id?: string }> }
  >,
  modelId: string,
  expected: Array<{ provider: string; service_id: string }>,
) {
  expect(models[modelId]?.endpoints).toEqual(expected);
}

describe("BitRouter Railway service", () => {
  test("runs BitRouter behind the authenticated proxy", () => {
    const dockerfile = readBitRouterFile("Dockerfile");
    const entrypoint = readBitRouterFile("entrypoint.sh");
    const proxy = readBitRouterFile("auth-proxy.mjs");

    expect(dockerfile).toContain("npm install -g bitrouter@0.33.0");
    expect(dockerfile).toContain("expect");
    expect(dockerfile).toContain('CMD ["/app/entrypoint.sh"]');
    expect(entrypoint).toContain(
      "bitrouter serve --config-file /app/bitrouter.yaml",
    );
    expect(entrypoint).toContain("BITROUTER_CEREBRAS_API_KEY");
    expect(entrypoint).toContain("CEREBRAS_API_KEY");
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
          api_base?: string;
          api_protocol?: string;
          api_key?: string;
          auto_discover?: boolean;
        }
      >;
      models?: Record<
        string,
        { endpoints?: Array<{ provider?: string; service_id?: string }> }
      >;
      inherit_defaults?: boolean;
    };
    const railway = readBitRouterFile("railway.toml");

    expect(config.server.listen).toBe("127.0.0.1:4356");
    expect(config.database.url).toBe("sqlite:/data/bitrouter.db");
    expect(config.providers).not.toHaveProperty("bitrouter");
    expect(config.providers).toHaveProperty("openrouter");
    expect(config.providers.openrouter).toEqual({});
    expect(config.providers.cerebras).toEqual({
      api_base: "https://api.cerebras.ai/v1",
      api_protocol: "openai",
      api_key: "$" + "{BITROUTER_CEREBRAS_API_KEY}",
      auto_discover: true,
    });
    expect(config.inherit_defaults).toBe(true);
    expect(config.models).toBeDefined();
    // gpt-oss-120b is Cerebras-ONLY (owner decision 2026-06-16): no OpenRouter
    // fallback — a slower fallback defeats the ~2000 tok/s reason we use it.
    expectEndpointChain(config.models ?? {}, "gpt-oss-120b", [
      { provider: "cerebras", service_id: "gpt-oss-120b" },
    ]);
    expectEndpointChain(config.models ?? {}, "openai/gpt-oss-120b", [
      { provider: "cerebras", service_id: "gpt-oss-120b" },
    ]);
    expectEndpointChain(config.models ?? {}, "openai/gpt-oss-120b:nitro", [
      { provider: "cerebras", service_id: "gpt-oss-120b" },
    ]);
    expectEndpointChain(config.models ?? {}, "anthropic/claude-haiku-4.5", [
      { provider: "openrouter", service_id: "anthropic/claude-haiku-4.5" },
    ]);
    expectEndpointChain(config.models ?? {}, "anthropic/claude-sonnet-4.6", [
      { provider: "openrouter", service_id: "anthropic/claude-sonnet-4.6" },
    ]);
    expectEndpointChain(config.models ?? {}, "x-ai/grok-4.20", [
      { provider: "openrouter", service_id: "x-ai/grok-4.20" },
    ]);
    expect(railway).toContain("[deploy]");
    expect(railway).toContain('healthcheckPath = "/health"');
  });
});
