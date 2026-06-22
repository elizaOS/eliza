// #8811 AC7 — flipping a RoutingMatrix slot's routing through the REAL settings
// UI changes the dispatched provider for that modality.
//
// The RoutingMatrix (Settings → Models & Providers → "Model routing & devices"
// disclosure, mounted via ProviderSwitcher) is the authoring surface for the
// per-modality routing policy. Each slot has a Policy select and a Preferred
// provider select. Changing either POSTs the modality→routing binding the agent
// dispatcher resolves against:
//   - POST /api/local-inference/routing/policy   { slot, policy }
//   - POST /api/local-inference/routing/preferred { slot, provider }
// The server returns the updated RoutingPreferences, which the matrix re-reads
// and re-renders.
//
// SCOPE NOTE — there is no separate client-observable "routing decision" surface
// in this harness (the dispatcher runs server-side; the keyless stub never makes
// a real model call). What IS deterministic, and is the load-bearing half of AC7,
// is that a UI routing change PROPAGATES to a routing OUTCOME rather than merely
// toggling a control: the renderer routes the new modality binding to the routing
// endpoint, AND the next routing read (the value the dispatcher would resolve)
// reflects it. This spec proves both by backing the routing endpoints with a
// STATEFUL mock that mirrors the real app-core behaviour: it persists the policy /
// preferred-provider write and serves it back as the canonical routing config.
// Setting TEXT_LARGE to manual + a specific provider therefore changes the
// resolved provider for that modality, which we assert at the routing-readout
// layer (the persisted, re-served preference the matrix displays after reload)
// and at the wire layer (the POST the renderer routed). Keyless against the stub.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

type RoutingPolicy =
  | "manual"
  | "cheapest"
  | "fastest"
  | "prefer-local"
  | "round-robin";

type RoutingPreferences = {
  preferredProvider: Record<string, string>;
  policy: Record<string, RoutingPolicy>;
};

type PolicyWrite = { slot: string; policy: RoutingPolicy };
type PreferredWrite = { slot: string; provider: string | null };

// Two real candidate providers registered for the TEXT_LARGE modality so the
// Preferred-provider select offers a concrete, switchable choice (mirrors the
// PublicRegistration shape served by /api/local-inference/routing).
const TEXT_LARGE_REGISTRATIONS = [
  {
    modelType: "TEXT_LARGE",
    provider: "ollama",
    priority: 100,
    registeredAt: "2026-01-01T00:00:00.000Z",
  },
  {
    modelType: "TEXT_LARGE",
    provider: "openai",
    priority: 50,
    registeredAt: "2026-01-01T00:00:00.000Z",
  },
];

const TARGET_PROVIDER = "openai";

interface RoutingMock {
  policyWrites: () => PolicyWrite[];
  preferredWrites: () => PreferredWrite[];
  currentPreferences: () => RoutingPreferences;
}

/**
 * Stateful routing backend matching real app-core semantics: GET serves the
 * canonical config (registrations + current preferences); the policy/preferred
 * POSTs mutate that config and echo it back. This is what makes a UI routing
 * flip a real routing OUTCOME — the next read resolves to the new binding.
 */
async function installStatefulRoutingMock(page: Page): Promise<RoutingMock> {
  const preferences: RoutingPreferences = {
    preferredProvider: {},
    policy: {},
  };
  const policyWrites: PolicyWrite[] = [];
  const preferredWrites: PreferredWrite[] = [];

  await page.route("**/api/local-inference/providers", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [] }),
    });
  });

  await page.route("**/api/local-inference/routing", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        registrations: TEXT_LARGE_REGISTRATIONS,
        preferences,
      }),
    });
  });

  await page.route("**/api/local-inference/routing/policy", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      slot?: string;
      policy?: RoutingPolicy | null;
    };
    if (body.slot && body.policy) {
      preferences.policy[body.slot] = body.policy;
      policyWrites.push({ slot: body.slot, policy: body.policy });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ preferences }),
    });
  });

  await page.route(
    "**/api/local-inference/routing/preferred",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        slot?: string;
        provider?: string | null;
      };
      if (body.slot) {
        const provider = body.provider ?? null;
        if (provider) {
          preferences.preferredProvider[body.slot] = provider;
        } else {
          delete preferences.preferredProvider[body.slot];
        }
        preferredWrites.push({ slot: body.slot, provider });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ preferences }),
      });
    },
  );

  return {
    policyWrites: () => policyWrites,
    preferredWrites: () => preferredWrites,
    currentPreferences: () => preferences,
  };
}

// The matrix renders each modality's Policy / Preferred-provider controls as
// Radix Select comboboxes. The trigger is a button with role "combobox" whose
// accessible name combines the slot label ("Large text" = TEXT_LARGE) with the
// control ("Policy" / "Preferred provider") and whose text content shows the
// current value. Activating it opens a PORTALED listbox of role "option" items.
// The RoutingMatrix lives inside a LAZY "Model routing & devices" <details>
// disclosure that only renders its children once open.
const LARGE_TEXT_POLICY_LABEL = /^Large text Policy$/;
const LARGE_TEXT_PREFERRED_LABEL = /^Large text Preferred provider$/;

interface RoutingMatrixControls {
  policyTrigger: ReturnType<Page["getByRole"]>;
  preferredTrigger: ReturnType<Page["getByRole"]>;
}

/** Expand the lazy "Model routing & devices" disclosure if it is collapsed. */
async function expandModelRoutingDisclosure(page: Page): Promise<void> {
  const summary = page
    .locator("#ai-model summary")
    .filter({ hasText: /Model routing & devices/i })
    .first();
  await expect(summary).toBeVisible({ timeout: 15_000 });
  const isOpen = await summary.evaluate((el) => {
    const details = el.closest("details");
    return Boolean(details?.open);
  });
  if (!isOpen) {
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
  }
}

/**
 * Open Settings → Models & Providers, expand the routing disclosure, and return
 * the TEXT_LARGE ("Large text") routing-control triggers from the RoutingMatrix.
 */
async function openRoutingMatrixLargeText(
  page: Page,
): Promise<RoutingMatrixControls> {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /Providers/);
  await expect(page.locator("#ai-model")).toBeVisible({ timeout: 30_000 });
  await expandModelRoutingDisclosure(page);

  const policyTrigger = page
    .locator("#ai-model")
    .getByRole("combobox", { name: LARGE_TEXT_POLICY_LABEL });
  const preferredTrigger = page
    .locator("#ai-model")
    .getByRole("combobox", { name: LARGE_TEXT_PREFERRED_LABEL });
  await expect(policyTrigger).toBeVisible({ timeout: 15_000 });
  await expect(preferredTrigger).toBeVisible({ timeout: 15_000 });
  return { policyTrigger, preferredTrigger };
}

/** Open a Radix Select trigger and click the option whose name matches. */
async function selectOptionByName(
  page: Page,
  trigger: ReturnType<Page["getByRole"]>,
  optionName: RegExp,
): Promise<void> {
  await trigger.click();
  // Options are portaled to the document body (outside #ai-model).
  const option = page.getByRole("option", { name: optionName });
  await expect(option.first()).toBeVisible({ timeout: 10_000 });
  await option.first().click();
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("RoutingMatrix: setting TEXT_LARGE to manual + a provider changes the dispatched provider for that modality", async ({
  page,
}) => {
  const routing = await installStatefulRoutingMock(page);
  const { policyTrigger, preferredTrigger } =
    await openRoutingMatrixLargeText(page);

  // Nothing is preferred yet (the trigger shows "Auto") and the policy defaults
  // to "Prefer local" — i.e. the dispatcher would NOT resolve to a specific
  // provider for this modality.
  await expect(preferredTrigger).toHaveText(/Auto/);
  await expect(policyTrigger).toHaveText(/Prefer local/);
  expect(
    routing.currentPreferences().preferredProvider.TEXT_LARGE,
  ).toBeUndefined();

  // Flip the policy to "Manual" — the routing mode under which the dispatcher
  // honours an explicit preferred provider.
  await selectOptionByName(page, policyTrigger, /^Manual$/);
  await expect.poll(() => routing.policyWrites().length).toBeGreaterThan(0);
  expect(routing.policyWrites().at(-1)).toEqual({
    slot: "TEXT_LARGE",
    policy: "manual",
  });
  await expect(policyTrigger).toHaveText(/Manual/);

  // Pick a concrete provider — the routing-outcome change: TEXT_LARGE now
  // resolves to `openai` instead of the prior auto/prefer-local default.
  await selectOptionByName(page, preferredTrigger, new RegExp(TARGET_PROVIDER));
  await expect.poll(() => routing.preferredWrites().length).toBeGreaterThan(0);
  expect(routing.preferredWrites().at(-1)).toEqual({
    slot: "TEXT_LARGE",
    provider: TARGET_PROVIDER,
  });

  // The UI change propagated to the routing CONFIG the dispatcher reads: the
  // stateful backend now resolves TEXT_LARGE to the chosen provider, and the
  // matrix re-renders that resolved value.
  await expect(preferredTrigger).toHaveText(new RegExp(TARGET_PROVIDER));
  expect(routing.currentPreferences().preferredProvider.TEXT_LARGE).toBe(
    TARGET_PROVIDER,
  );
  expect(routing.currentPreferences().policy.TEXT_LARGE).toBe("manual");

  // Persistence / propagation across a fresh read: leave and re-open the section
  // so the matrix re-fetches GET /api/local-inference/routing. The resolved
  // provider survives because the change round-tripped through the routing
  // config the next dispatch would consult — not just a local control toggle.
  await openSettingsSection(page, /Voice/);
  const reopened = await openRoutingMatrixLargeText(page);

  await expect(reopened.policyTrigger).toHaveText(/Manual/);
  await expect(reopened.preferredTrigger).toHaveText(
    new RegExp(TARGET_PROVIDER),
  );
});
