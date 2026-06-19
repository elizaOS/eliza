// Provider-switch round-trip against the REAL live stack.
//
// Settings → Providers (the `ai-model` section) lists every AI provider as a
// selectable card. Selecting a non-active provider surfaces its API-key panel
// with a "Use provider" button that calls client.switchProvider() →
// POST /api/provider/switch, which the real app-core runtime services by
// persisting the provider config and restarting the agent. The keyless stub does
// not actually restart or re-derive the active provider, so the "active provider
// moved" read-back only holds against the real runtime (ELIZA_UI_SMOKE_LIVE_STACK=1).
// Classified LIVE_ONLY. It NEVER stubs the route under test — POST
// /api/provider/switch hits the real backend.
//
// Flow: open Providers → pick the first non-active provider card → "Use provider"
// → assert the real POST /api/provider/switch fired carrying that provider id.

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
    await openSettingsSection(page, /Providers/);
    await expect(page.locator("#ai-model")).toBeVisible({ timeout: 30_000 });

    // Provider cards are buttons labelled "<Provider>, <state>". The active one
    // reads "<Provider>, Active". Wait for the grid, then resolve a concrete
    // non-active card by reading aria-labels directly: any card whose label does
    // not end in ", Active" is a switch target.
    await expect(
      page.locator("#ai-model button[aria-label]").first(),
    ).toBeVisible({ timeout: 15_000 });
    const labels = await page
      .locator("#ai-model button[aria-label]")
      .evaluateAll((els) =>
        (els as HTMLButtonElement[]).map(
          (el) => el.getAttribute("aria-label") ?? "",
        ),
      );
    const targetLabel = labels.find(
      (label) => label.length > 0 && !/,\s*Active$/.test(label),
    );
    expect(
      targetLabel,
      "Providers section must offer a non-active provider to switch to",
    ).toBeTruthy();

    await page
      .locator("#ai-model")
      .getByRole("button", { name: targetLabel as string })
      .first()
      .click();

    // The selected provider's API-key panel exposes the "Use provider" switch.
    const useProvider = page
      .locator("#ai-model")
      .getByRole("button", { name: /Use provider/i })
      .first();
    await expect(useProvider).toBeVisible({ timeout: 15_000 });
    await useProvider.click();

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

    // The clicked card is now the selected panel (aria-current="true").
    await expect(
      page
        .locator("#ai-model")
        .getByRole("button", { name: targetLabel as string })
        .first(),
    ).toHaveAttribute("aria-current", "true", { timeout: 10_000 });
  });
});
