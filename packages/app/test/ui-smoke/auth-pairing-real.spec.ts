/**
 * Real app-core pairing e2e for the production auth wall.
 *
 * Unlike auth-startup.spec.ts, this does not fulfill /api/auth/* from
 * Playwright. It starts a real startApiServer runtime with pairing enabled,
 * reads the operator-visible pair code from the server process, submits it
 * through the rendered pairing UI, and verifies the minted machine-session
 * bearer survives a reload.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  _resetAuthPairingStateForTests,
  ensureAuthPairingCodeForRemoteAccess,
} from "../../../app-core/src/api/auth-pairing-routes.ts";
import { startApiServer } from "../../../app-core/src/api/server.ts";
import { useIsolatedConfigEnv } from "../../../app-core/test/helpers/isolated-config.ts";
import { createRealTestRuntime } from "../../../app-core/test/helpers/real-runtime.ts";
import { saveEnv } from "../../../app-core/test/helpers/test-utils.ts";
import { openAppPath, seedAppStorage } from "./helpers";

const STATIC_API_TOKEN = "ui-smoke-static-pairing-token";

type StartedPairingApi = {
  baseUrl: string;
  close: () => Promise<void>;
};

function chatComposer(page: Page) {
  return page.getByTestId("chat-composer-textarea");
}

async function postFirstRunComplete(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/first-run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${STATIC_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Pairing E2E" }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to seed first-run state (${response.status}): ${await response.text()}`,
    );
  }
}

async function startPairingEnabledApi(): Promise<StartedPairingApi> {
  const env = saveEnv(
    "ELIZA_API_TOKEN",
    "ELIZA_PAIRING_DISABLED",
    "ELIZA_REQUIRE_LOCAL_AUTH",
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_DEV_AUTH_BYPASS",
    "ELIZA_CONFIG_PATH",
  );
  process.env.ELIZA_API_TOKEN = STATIC_API_TOKEN;
  delete process.env.ELIZA_PAIRING_DISABLED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_DEV_AUTH_BYPASS;

  const configEnv = useIsolatedConfigEnv("eliza-ui-smoke-pairing-");
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>> | null =
    null;
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;

  try {
    _resetAuthPairingStateForTests();
    runtimeResult = await createRealTestRuntime({
      characterName: "PairingUiSmoke",
    });
    server = await startApiServer({
      port: 0,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    await postFirstRunComplete(baseUrl);
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    return {
      baseUrl,
      close: async () => {
        await server?.close();
        await runtimeResult?.cleanup();
        await configEnv.restore();
        _resetAuthPairingStateForTests();
        env.restore();
      },
    };
  } catch (error) {
    await server?.close().catch(() => undefined);
    await runtimeResult?.cleanup().catch(() => undefined);
    await configEnv.restore().catch(() => undefined);
    _resetAuthPairingStateForTests();
    env.restore();
    throw error;
  }
}

test("remote pairing against real app-core mints a machine session and survives reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const api = await startPairingEnabledApi();
  const authRequests: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.url().startsWith(api.baseUrl) &&
      url.pathname.startsWith("/api/auth")
    ) {
      authRequests.push(
        `${request.method()} ${url.pathname} auth=${request.headers().authorization ? "bearer" : "none"}`,
      );
    }
  });

  try {
    await seedAppStorage(page, {
      "elizaos:active-server": JSON.stringify({
        id: "remote:real-pairing-ui-smoke",
        kind: "remote",
        label: "Real Pairing UI Smoke",
        apiBase: api.baseUrl,
      }),
    });

    await openAppPath(page, "/chat");
    await expect(page.getByText("Pairing Required")).toBeVisible();

    const pairing = ensureAuthPairingCodeForRemoteAccess();
    expect(pairing, "real pairing code should be available").toBeTruthy();
    await page.getByPlaceholder("Enter pairing code").fill(pairing?.code ?? "");
    const pairResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.url().startsWith(api.baseUrl) &&
        url.pathname === "/api/auth/pair" &&
        response.request().method() === "POST"
      );
    });
    await page.getByRole("button", { name: "Submit" }).click();
    const pairResponse = await pairResponsePromise;
    expect(pairResponse.ok()).toBe(true);
    await expect(page.getByText("Pairing Required")).toHaveCount(0);
    await expect(chatComposer(page)).toBeVisible();

    const storedToken = await page.evaluate(() => {
      const raw = window.localStorage.getItem("elizaos:active-server");
      return raw ? (JSON.parse(raw).accessToken as string | undefined) : null;
    });
    expect(storedToken).toBeTruthy();
    expect(storedToken).not.toBe(STATIC_API_TOKEN);

    const authedStatus = await fetch(`${api.baseUrl}/api/auth/status`, {
      headers: { authorization: `Bearer ${storedToken}` },
    });
    expect(authedStatus.ok).toBe(true);
    await expect(authedStatus.json()).resolves.toMatchObject({
      authenticated: true,
      required: false,
      pairingEnabled: true,
    });

    const authMe = await fetch(`${api.baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${storedToken}` },
    });
    expect(authMe.ok).toBe(true);
    await expect(authMe.json()).resolves.toMatchObject({
      session: {
        id: storedToken,
        kind: "machine",
      },
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Pairing Required")).toHaveCount(0);
    await expect(chatComposer(page)).toBeVisible();
    expect(authRequests).toContain("POST /api/auth/pair auth=none");
    expect(authRequests).toContain("GET /api/auth/status auth=bearer");
  } finally {
    await api.close();
  }
});
