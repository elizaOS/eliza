/**
 * Exercises provider switching through the real live-stack account and runtime
 * routes. The test creates its own linked account because process-level API-key
 * credentials intentionally do not appear as user-managed account rows.
 */

import { expect, type Page, test } from "@playwright/test";
import { openAppPath, openSettingsSection, seedAppStorage } from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

type SwitchRequest = { provider: unknown; primaryModel?: unknown };

const TEST_PROVIDER_ID = "cerebras-api";

async function mutateAccount(
  page: Page,
  path: string,
  method: "POST" | "DELETE",
  body?: Record<string, unknown>,
): Promise<unknown> {
  return page.evaluate(
    async ({ path: requestPath, method: requestMethod, body: requestBody }) => {
      const csrfCookie = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("eliza_csrf="));
      const csrfToken = csrfCookie
        ? decodeURIComponent(csrfCookie.slice("eliza_csrf=".length))
        : null;
      const response = await fetch(requestPath, {
        method: requestMethod,
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(csrfToken ? { "x-eliza-csrf": csrfToken } : {}),
        },
        ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
      });
      if (!response.ok) {
        throw new Error(
          `${requestMethod} ${requestPath} failed with ${response.status}: ${await response.text()}`,
        );
      }
      return response.status === 204 ? null : response.json();
    },
    { path, method, body },
  );
}

function captureProviderSwitches(page: Page): SwitchRequest[] {
  const requests: SwitchRequest[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (!/\/api\/provider\/switch(?:\?|$)/.test(req.url())) return;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    if (body && typeof body === "object") {
      requests.push(body as SwitchRequest);
    }
  });
  return requests;
}

test.describe("provider config deep round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real provider/runtime pipeline (ELIZA_UI_SMOKE_LIVE_STACK=1); the " +
      "keyless stub does not restart the agent or re-derive the active provider.",
  );

  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
  });

  test("selecting a different provider fires POST /api/provider/switch with its id", async ({
    page,
  }) => {
    const switches = captureProviderSwitches(page);

    await openAppPath(page, "/settings");
    const created = (await mutateAccount(
      page,
      `/api/accounts/${TEST_PROVIDER_ID}`,
      "POST",
      {
        source: "api-key",
        label: "Live E2E switch target",
        apiKey: "csk-live-e2e-switch-target",
      },
    )) as { id?: unknown };
    expect(typeof created.id).toBe("string");

    // Reload the inventory after creating the fixture through the real route.
    await openAppPath(page, "/settings");
    await openSettingsSection(page, /Models & Providers/);
    await expect(page.locator("#ai-model")).toBeVisible({ timeout: 30_000 });

    // Connected direct-provider rows expose this as their primary routing
    // action. The active provider instead renders a disabled "Chat" button, so
    // the first enabled match is necessarily a real switch target.
    const useForChat = page
      .locator("#ai-model")
      .getByRole("button", { name: /^Use for chat$/i })
      .first();
    await expect(useForChat).toBeVisible({ timeout: 15_000 });
    await expect(useForChat).toBeEnabled();
    await useForChat.click();

    // Real POST /api/provider/switch carrying a concrete provider id — the
    // load-bearing contract, independent of whether the restart later succeeds
    // (a keyless target provider may be rejected by the backend for lacking a
    // credential, but the switch request itself is what the UI is responsible for).
    await expect.poll(() => switches.length).toBeGreaterThan(0);
    expect(
      switches.some(
        (s) => typeof s.provider === "string" && s.provider.length > 0,
      ),
    ).toBe(true);

    // The clicked account action becomes the active, disabled "Chat" state.
    await expect(useForChat).toHaveCount(0, { timeout: 10_000 });

    await mutateAccount(
      page,
      `/api/accounts/${TEST_PROVIDER_ID}/${String(created.id)}`,
      "DELETE",
    );
  });
});
