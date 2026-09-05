/**
 * Verifies private Pi provider materialization with real temporary files and
 * child-environment isolation; no live provider request is made.
 */

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enforcePiProviderCredentialIsolation,
  PI_PROVIDER_ROUTES,
  preparePiProviderRoute,
} from "../../src/services/pi-provider-config.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function prepare(
  providerId: keyof typeof PI_PROVIDER_ROUTES,
  model?: string,
) {
  const root = await mkdtemp(path.join(tmpdir(), "eliza-pi-route-"));
  roots.push(root);
  const route = PI_PROVIDER_ROUTES[providerId];
  return preparePiProviderRoute({
    sessionId: `session-${providerId}`,
    stateRoot: root,
    selection: {
      providerId,
      accountId: "account-1",
      label: "Primary",
      source: providerId.endsWith("-coding") ? "coding-plan-key" : "api-key",
      strategy: "least-used",
      envPatch: { [route.keyEnv]: `secret-${providerId}` },
    },
    model,
  });
}

describe("Pi provider routes", () => {
  it.each(Object.keys(PI_PROVIDER_ROUTES))(
    "materializes %s without persisting its credential",
    async (providerId) => {
      const typed = providerId as keyof typeof PI_PROVIDER_ROUTES;
      const result = await prepare(
        typed,
        typed === "openrouter-api" ? "anthropic/claude-sonnet-4.5" : undefined,
      );
      const home = result.env.PI_CODING_AGENT_DIR;
      const models = await readFile(path.join(home, "models.json"), "utf8");
      const settings = await readFile(path.join(home, "settings.json"), "utf8");
      const parsedModels = JSON.parse(models) as {
        providers: Record<
          string,
          { apiKey: string; models?: Array<{ id: string }> }
        >;
      };
      const provider = parsedModels.providers[result.summary.piProviderId];
      expect(provider?.apiKey).toBe("$ELIZA_PI_ROUTE_API_KEY");
      expect(models).not.toContain(`secret-${providerId}`);
      expect(settings).not.toContain(`secret-${providerId}`);
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(home, "models.json"))).mode & 0o777).toBe(
        0o600,
      );
      expect(result.summary.accountProviderId).toBe(providerId);
      if (typed === "openrouter-api") {
        expect(provider?.models).toEqual([
          {
            id: "anthropic/claude-sonnet-4.5",
            name: "anthropic/claude-sonnet-4.5",
          },
        ]);
      } else {
        expect(provider).not.toHaveProperty("models");
      }
    },
  );

  it("uses Pi built-ins without replacing their model capability metadata", async () => {
    for (const providerId of [
      "zai-coding",
      "kimi-coding",
      "deepseek-api",
      "zai-api",
      "moonshot-api",
      "xai-api",
    ] as const) {
      const result = await prepare(providerId);
      const raw = await readFile(
        path.join(result.env.PI_CODING_AGENT_DIR, "models.json"),
        "utf8",
      );
      const config = JSON.parse(raw) as {
        providers: Record<string, { models?: unknown }>;
      };
      expect(result.summary.builtIn).toBe(true);
      expect(config.providers[result.summary.piProviderId]).not.toHaveProperty(
        "models",
      );
    }
  });

  it("supports an arbitrary OpenRouter model with truthful billing", async () => {
    const result = await prepare("openrouter-api", "moonshotai/kimi-k2.5");
    expect(result.summary).toMatchObject({
      piProviderId: "openrouter",
      model: "moonshotai/kimi-k2.5",
      billingMode: "api-credits-or-byok",
      termsPolicy: "credits-or-byok",
      builtIn: true,
    });
  });

  it("requires an explicit OpenRouter model", async () => {
    await expect(prepare("openrouter-api")).rejects.toMatchObject({
      code: "PI_PROVIDER_MODEL_INVALID",
    });
  });

  it("rejects malformed models and keeps endpoints on the typed allowlist", async () => {
    await expect(prepare("deepseek-api", "bad\nmodel")).rejects.toMatchObject({
      code: "PI_PROVIDER_MODEL_INVALID",
    });
    for (const route of Object.values(PI_PROVIDER_ROUTES)) {
      const endpoint = new URL(route.baseUrl);
      expect(endpoint.protocol).toBe("https:");
      expect(endpoint.username).toBe("");
      expect(endpoint.password).toBe("");
    }
  });

  it("removes every competing provider key at the final child boundary", () => {
    const env: NodeJS.ProcessEnv = {
      ELIZA_PI_PROVIDER_ROUTE: "deepseek-api",
      ELIZA_PI_ROUTE_API_KEY: "selected",
      DEEPSEEK_API_KEY: "selected-original",
      OPENAI_API_KEY: "ambient",
      XAI_API_KEY: "ambient",
      OPENROUTER_API_KEY: "ambient",
    };
    enforcePiProviderCredentialIsolation(env);
    expect(env).toEqual({ ELIZA_PI_ROUTE_API_KEY: "selected" });
  });
});
