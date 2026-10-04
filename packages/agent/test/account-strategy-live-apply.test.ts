/**
 * The boot runtime and the API server hold separate config objects, so a
 * rotation-strategy change must reach the live account-pool selection through
 * the route itself, for subscription providers as well as direct API keys.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.ELIZA_STATE_DIR = mkdtempSync(
  path.join(os.tmpdir(), "strategy-patch-"),
);

const { applyAccountPoolApiCredentials, selectionForProvider } = await import(
  "@elizaos/auth/accounts"
);
const { setAgentHostBridge } = await import("../src/runtime/host-bridge.ts");
const { handleAccountsRoutes } = await import("../src/api/accounts-routes.ts");

setAgentHostBridge({
  applyAccountPoolApiCredentials: (o: never) =>
    applyAccountPoolApiCredentials(o),
} as never);

async function patchStrategy(
  config: Record<string, unknown>,
  providerId: string,
  strategy: string,
) {
  let status = 200;
  let body: unknown;
  await handleAccountsRoutes({
    req: {} as never,
    res: {} as never,
    method: "PATCH",
    pathname: `/api/providers/${providerId}/strategy`,
    readJsonBody: async () => ({ strategy }),
    json: (_res: unknown, data: unknown, s = 200) => {
      status = s;
      body = data;
    },
    error: (_res: unknown, msg: string, s = 500) => {
      status = s;
      body = { error: msg };
    },
    state: { config: config as never, runtime: null },
    saveConfig: () => {},
  } as never);
  return { status, body };
}

describe("PATCH /api/providers/:id/strategy reaches the live pool selection", () => {
  it("applies a direct API provider strategy", async () => {
    const config: Record<string, unknown> = {
      accountStrategies: { "openai-api": "priority" },
    };
    await applyAccountPoolApiCredentials({
      accountStrategies: structuredClone(config.accountStrategies) as never,
    });
    await patchStrategy(config, "openai-api", "round-robin");
    expect(selectionForProvider("openai-api").strategy).toBe("round-robin");
  });

  it("applies a Codex subscription strategy", async () => {
    const config: Record<string, unknown> = {
      accountStrategies: { "openai-codex": "priority" },
    };
    await applyAccountPoolApiCredentials({
      accountStrategies: structuredClone(config.accountStrategies) as never,
    });
    await patchStrategy(config, "openai-codex", "least-used");
    expect(selectionForProvider("openai-codex").strategy).toBe("least-used");
  });

  it("applies an Anthropic subscription strategy", async () => {
    const config: Record<string, unknown> = {
      accountStrategies: { "anthropic-subscription": "priority" },
    };
    await applyAccountPoolApiCredentials({
      accountStrategies: structuredClone(config.accountStrategies) as never,
    });
    await patchStrategy(config, "anthropic-subscription", "round-robin");
    expect(selectionForProvider("anthropic-subscription").strategy).toBe(
      "round-robin",
    );
  });
});
