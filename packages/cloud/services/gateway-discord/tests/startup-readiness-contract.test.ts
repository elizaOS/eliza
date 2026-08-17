/** Exercises the real gateway startup boundary that Railway uses for admission. */

import { afterEach, expect, mock, test } from "bun:test";
import { GATEWAY_TOKEN_REQUEST_TIMEOUT_MS } from "@elizaos/cloud-services-common/gateway-auth";
import { GatewayManager } from "../src/gateway-manager";

const originalFetch = globalThis.fetch;
const originalBotEnabled = process.env.ELIZA_APP_DISCORD_BOT_ENABLED;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBotEnabled === undefined) {
    delete process.env.ELIZA_APP_DISCORD_BOT_ENABLED;
  } else {
    process.env.ELIZA_APP_DISCORD_BOT_ENABLED = originalBotEnabled;
  }
  mock.restore();
});

test("allows bounded cold token acquisition before Railway admits the replica", async () => {
  expect(GATEWAY_TOKEN_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);

  const railwayConfig = await Bun.file(
    new URL("../railway.toml", import.meta.url),
  ).text();
  expect(railwayConfig).toContain('healthcheckPath = "/ready"');
  expect(railwayConfig).toContain("healthcheckTimeout = 90");
});

test("stays unready through delayed authentication and admits only after the first poll", async () => {
  process.env.ELIZA_APP_DISCORD_BOT_ENABLED = "false";
  let resolveToken: ((response: Response) => void) | undefined;
  globalThis.fetch = mock(async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/token")) {
      return await new Promise<Response>((resolve) => {
        resolveToken = resolve;
      });
    }
    if (path.endsWith("/discord/gateway/shutdown")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;

  const manager = new GatewayManager(
    {
      podName: "readiness-test-pod",
      elizaCloudUrl: "https://api.test",
      gatewayBootstrapSecret: "bootstrap-secret",
      project: "test",
    },
    {
      fetchAssignments: mock(async () =>
        Response.json({ assignments: [] }),
      ) as typeof fetch,
    },
  );

  expect(manager.isReady()).toBeFalse();
  const startup = manager.start();
  await waitFor(() => resolveToken !== undefined);
  expect(manager.isReady()).toBeFalse();

  resolveToken?.(
    Response.json({
      access_token: "ready-token",
      token_type: "Bearer",
      expires_in: 60,
    }),
  );
  await startup;
  try {
    expect(manager.isReady()).toBeTrue();
    expect(manager.getHealth().controlPlane.lastSuccessfulPoll).not.toBeNull();
  } finally {
    await manager.shutdown();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for gateway state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
