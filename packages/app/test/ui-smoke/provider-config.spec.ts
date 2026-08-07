// Provider-switch round-trip against the REAL live stack.
//
// Settings → Models & Providers (the `ai-model` section) exposes connected
// direct-provider accounts with a primary "Use for chat" action. That action
// calls client.switchProvider() → POST /api/provider/switch, which the real
// app-core runtime services. Classified LIVE_ONLY. It NEVER stubs the route
// under test — POST /api/provider/switch hits the real backend.
//
// Flow: open Models & Providers → click the first enabled "Use for chat"
// account action → assert the real POST /api/provider/switch fired with a
// concrete provider id.

import { expect, type Page, test } from "@playwright/test";
import { openAppPath, openSettingsSection, seedAppStorage } from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

type SwitchRequest = { provider: unknown; primaryModel?: unknown };

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
  });
});
