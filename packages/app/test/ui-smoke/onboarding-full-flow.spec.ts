/**
 * Web onboarding — full end-to-end flow (W1–W11 from docs/QA-onboarding.md).
 *
 * The shipping web onboarding is the `RuntimeGate` component, NOT the
 * abstract step graph (deployment → providers → features) in
 * packages/ui/src/onboarding/flow.ts. The wizard renders a single
 * `WelcomeChooser` whose primary action is "Get started" (cloud
 * fast-track) and whose advanced disclosure exposes "Use local" /
 * "Connect remote" — but only when the running build can host a local
 * agent (desktop / Vite dev / mobile native). On the production web
 * build that the playwright-ui-live-stack serves, the local probe is
 * unconditionally false, so the WelcomeChooser only ever surfaces
 * Cloud and Remote. Tests that depend on the local sub-view document
 * this and degrade to verifying the absence of the relevant UI rather
 * than driving an unreachable path.
 *
 * The picker override `?runtime=picker&pickerTarget=local` documented
 * in RuntimeGate is similarly gated on `runtimeChoices.includes("local")`
 * — it only opens the local sub-view when the live build already
 * advertises Local in the chooser. On production web smoke it is a
 * no-op.
 *
 * No real network: all `/api/*` reachable from the UI is mocked via
 * Playwright route interception in the same style as
 * `auth-startup.spec.ts` and `cloud-provisioning-startup.spec.ts`.
 */

import { expect, type Page, type Route, test } from "@playwright/test";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

const ONBOARDING_COMPLETE_STORAGE_KEY = "eliza:onboarding-complete";
const ONBOARDING_STEP_STORAGE_KEY = "eliza:onboarding:step";
const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

/**
 * The translated heading is "Welcome to Eliza" (i18n key
 * `runtimegate.welcomeTitle`). The in-repo defaultValue says "Welcome
 * to Milady" but the shipped translation overrides it. Match either so
 * the spec is resilient to translation churn.
 */
const WELCOME_HEADING_REGEX = /welcome to (eliza|milady)/i;

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Reset localStorage / sessionStorage on every navigation so each test
 * in the serial run starts from a clean slate where it expects to.
 */
async function clearStorageBeforeNavigation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // Storage failures surface as later assertion failures.
    }
  });
}

/**
 * Mocks every backend endpoint the onboarding-required path touches.
 * Keeps onboarding in the "fresh install, no provider configured" state
 * so RuntimeGate renders without auto-skip.
 */
async function installOnboardingMocks(page: Page): Promise<void> {
  await installDefaultAppRoutes(page);

  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });

  await page.route("**/api/onboarding/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      complete: false,
      cloudProvisioned: false,
    });
  });

  // POST /api/provider/switch is the canonical write path for the
  // local-runtime sub-view. Mocked in case any future change surfaces
  // that path during this spec — present today as a precautionary
  // route so the suite does not silently hit the real backend.
  await page.route("**/api/provider/switch", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, { success: true });
  });
}

/**
 * The runtime gate root mounts with `data-testid="onboarding-ui-overlay"`
 * regardless of which sub-view it renders. Use that as the most stable
 * presence anchor; supplement with role-based assertions for specific
 * sub-view content.
 */
async function expectRuntimeGateMounted(page: Page): Promise<void> {
  await expect(page.getByTestId("onboarding-ui-overlay")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: WELCOME_HEADING_REGEX }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /get started/i }),
  ).toBeVisible();
}

test.describe
  .serial("web onboarding — full flow (W1–W11)", () => {
    test("W1 cold launch renders the runtime gate landing", async ({
      page,
    }) => {
      await clearStorageBeforeNavigation(page);
      await installOnboardingMocks(page);

      await openAppPath(page, "/chat");
      await expectRuntimeGateMounted(page);

      // Completion flag must NOT already be set on a fresh launch.
      await expect
        .poll(() =>
          page.evaluate(
            (key) => localStorage.getItem(key),
            ONBOARDING_COMPLETE_STORAGE_KEY,
          ),
        )
        .toBeNull();
    });

    test("W2 advanced disclosure surfaces the power-user options", async ({
      page,
    }) => {
      // QA doc W2: "Choose Local deployment". On the production web build
      // the local probe (probe-local-agent.ts) returns false, so the
      // chooser only advertises Cloud + Remote. We verify the advanced
      // disclosure opens and shows at least one power-user option
      // (Connect remote on web; Use local would also appear on a
      // desktop/dev build) so a future regression that breaks the
      // disclosure entirely is caught.
      await clearStorageBeforeNavigation(page);
      await installOnboardingMocks(page);

      await openAppPath(page, "/chat");
      await expectRuntimeGateMounted(page);

      const disclosureToggle = page.getByRole("button", {
        name: /i want to run it myself/i,
      });
      await disclosureToggle.click();
      await expect(disclosureToggle).toHaveAttribute("aria-expanded", "true");

      // At least the "Connect remote" power-user card is present on
      // every web build; "Use local" only renders when the build can
      // host a local agent.
      await expect(page.getByText(/already running an agent\?/i)).toBeVisible();
    });

    // W3 (password setup): the PasswordSetupStep component exists at
    // packages/ui/src/components/onboarding/PasswordSetupStep.tsx but
    // is NOT mounted by the web onboarding flow on a fresh local launch.
    // We assert its absence so a regression that accidentally surfaces
    // it during a vanilla install is caught.
    test("W3 fresh launch does not surface password setup", async ({
      page,
    }) => {
      await clearStorageBeforeNavigation(page);
      await installOnboardingMocks(page);

      await openAppPath(page, "/chat");
      await expectRuntimeGateMounted(page);

      await expect(
        page.getByRole("heading", { name: /set your login password/i }),
      ).toHaveCount(0);
      await expect(
        page.locator('form[aria-label="Password setup"]'),
      ).toHaveCount(0);
    });

    // W4 + W5 (provider step + API key entry): the local-runtime
    // sub-view that hosts the provider catalog + key form
    // (RuntimeGate `subView === "local"` / `localStage === "config"`) is
    // unreachable on the production web build the playwright live stack
    // serves — `runtimeChoices` excludes "local" so neither the advanced
    // disclosure card nor the `?runtime=picker&pickerTarget=local`
    // override can navigate there. We assert that explicitly: the
    // "Pick a model provider" eyebrow must NOT render after clicking
    // through the chooser, and the picker-override URL must keep
    // rendering the chooser landing. Desktop and mobile builds exercise
    // this sub-view via their own surface-specific specs.
    test("W4 + W5 local provider + API key sub-view is gated on local availability", async ({
      page,
    }) => {
      await clearStorageBeforeNavigation(page);
      await installOnboardingMocks(page);

      await page.goto("/?runtime=picker&pickerTarget=local", {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator("#root")).toBeVisible();

      await expect(page.getByTestId("onboarding-ui-overlay")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: WELCOME_HEADING_REGEX }),
      ).toBeVisible();
      await expect(page.getByText(/pick a model provider/i)).toHaveCount(0);
      await expect(page.getByText(/add your api key/i)).toHaveCount(0);
    });

    // W6 + W7 (feature toggles step + character pick): the shipping web
    // onboarding does NOT include separate feature-toggle or
    // character-pack steps. Those choices are made post-onboarding from
    // Settings / the apps catalog. Verify their absence.
    test("W6 + W7 no separate feature-toggle or character-pick steps render", async ({
      page,
    }) => {
      await clearStorageBeforeNavigation(page);
      await installOnboardingMocks(page);

      await openAppPath(page, "/chat");
      await expectRuntimeGateMounted(page);

      await expect(
        page.getByRole("heading", { name: /feature toggles/i }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: /choose your character/i }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: /pick a character/i }),
      ).toHaveCount(0);
    });

    test("W8 completing the remote flow writes eliza:onboarding-complete=1", async ({
      page,
      baseURL,
    }) => {
      // Drive the only end-to-end finish path the production web build
      // exposes without a real cloud backend: "Connect remote". This
      // mirrors the canonical contract verified end-to-end by the cloud
      // path in cloud-provisioning-startup.spec.ts; using the remote
      // sub-view here keeps the spec self-contained.
      expect(baseURL).toBeTruthy();
      const apiBase = (baseURL ?? "").replace(/\/$/, "");

      await clearStorageBeforeNavigation(page);
      await installOnboardingMocks(page);

      await openAppPath(page, "/chat");
      await expectRuntimeGateMounted(page);

      await page
        .getByRole("button", { name: /i want to run it myself/i })
        .click();
      await page
        .getByRole("button", { name: /already running an agent\?/i })
        .click();

      const remoteUrlInput = page.getByPlaceholder(/https?:\/\/your-agent/i);
      await remoteUrlInput.fill(apiBase || "http://127.0.0.1:31337");

      await page.getByRole("button", { name: /^connect$/i }).click();

      await expect
        .poll(() =>
          page.evaluate(
            (key) => localStorage.getItem(key),
            ONBOARDING_COMPLETE_STORAGE_KEY,
          ),
        )
        .toBe("1");
      await expect
        .poll(() =>
          page.evaluate(
            (key) => localStorage.getItem(key),
            ACTIVE_SERVER_STORAGE_KEY,
          ),
        )
        .not.toBeNull();
    });

    test("W9 reload after onboarding-complete does not re-enter the gate", async ({
      page,
    }) => {
      // Seed the completed state directly. We test the persistence
      // contract: a present `eliza:onboarding-complete=1` flag + a valid
      // active server entry must NOT re-render the RuntimeGate landing.
      await page.addInitScript(
        ({ completeKey, activeServerKey }) => {
          try {
            localStorage.clear();
            sessionStorage.clear();
            localStorage.setItem(completeKey, "1");
            localStorage.setItem(
              activeServerKey,
              JSON.stringify({
                id: "local:embedded",
                kind: "local",
                label: "This device",
              }),
            );
          } catch {
            // ignored
          }
        },
        {
          completeKey: ONBOARDING_COMPLETE_STORAGE_KEY,
          activeServerKey: ACTIVE_SERVER_STORAGE_KEY,
        },
      );
      await installOnboardingMocks(page);

      await page.goto("/chat", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root")).toBeVisible();

      await expect(page.getByTestId("onboarding-ui-overlay")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: WELCOME_HEADING_REGEX }),
      ).toHaveCount(0);
    });

    test("W10 ?reset clears completion and re-renders the gate", async ({
      page,
    }) => {
      // First arrive with a completed state, then navigate to `/?reset`
      // which `applyForceFreshOnboardingReset` consumes during boot to
      // clear active-server / step / complete keys and strip the param.
      await page.addInitScript(
        ({ completeKey, activeServerKey }) => {
          try {
            localStorage.clear();
            sessionStorage.clear();
            localStorage.setItem(completeKey, "1");
            localStorage.setItem(
              activeServerKey,
              JSON.stringify({
                id: "local:embedded",
                kind: "local",
                label: "This device",
              }),
            );
          } catch {
            // ignored
          }
        },
        {
          completeKey: ONBOARDING_COMPLETE_STORAGE_KEY,
          activeServerKey: ACTIVE_SERVER_STORAGE_KEY,
        },
      );
      await installOnboardingMocks(page);

      await page.goto("/?reset", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root")).toBeVisible();

      await expect
        .poll(() =>
          page.evaluate(
            (key) => localStorage.getItem(key),
            ONBOARDING_COMPLETE_STORAGE_KEY,
          ),
        )
        .toBeNull();
      await expect(page.getByTestId("onboarding-ui-overlay")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: WELCOME_HEADING_REGEX }),
      ).toBeVisible();
    });

    test("W11 persisted onboarding step keeps the gate mounted on reload", async ({
      page,
    }) => {
      // Resume contract (onboarding-resume.ts): a persisted partial step
      // with no completion flag must keep the wizard mounted. Because
      // RuntimeGate is the single entry point for the shipping web
      // onboarding surface, a mid-flow resume manifests as the gate
      // re-rendering rather than a deep-link to a specific page.
      await page.addInitScript(
        ({ stepKey }) => {
          try {
            localStorage.clear();
            sessionStorage.clear();
            localStorage.setItem(stepKey, "providers");
          } catch {
            // ignored
          }
        },
        { stepKey: ONBOARDING_STEP_STORAGE_KEY },
      );
      await installOnboardingMocks(page);

      await page.goto("/chat", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root")).toBeVisible();

      await expect(page.getByTestId("onboarding-ui-overlay")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: WELCOME_HEADING_REGEX }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            (key) => localStorage.getItem(key),
            ONBOARDING_STEP_STORAGE_KEY,
          ),
        )
        .toBe("providers");
      await expect
        .poll(() =>
          page.evaluate(
            (key) => localStorage.getItem(key),
            ONBOARDING_COMPLETE_STORAGE_KEY,
          ),
        )
        .toBeNull();
    });
  });
