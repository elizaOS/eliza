/**
 * Exercises real login, provisioning, and chat through the app UI against
 * Eliza Cloud, without mocking cloud endpoints. The opt-in workflow must supply
 * both live-stack flags and ELIZAOS_CLOUD_API_KEY; this test spends real cloud
 * credits and must never run in a keyless PR lane.
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { seedCloudLiveBrowserAuth } from "../cloud-live-browser-auth";
import { assertOnboardingLiveness } from "../liveness-contract";
import { openAppPath, seedAppStorage } from "./helpers";

const CLOUD_LIVE_ENABLED =
  process.env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1" &&
  process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const HAS_CLOUD_KEY = Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim());

const PROVISION_ATTEMPT_TIMEOUT_MS = 180_000;
const PROVISION_ATTEMPTS = 2;

// This lane deliberately places a real Cloud bearer in browser storage. A
// Playwright trace records init-script arguments and request headers, so never
// retain a trace that could publish the credential in the uploaded artifact.
test.use({ trace: "off" });

async function clickIfVisible(
  locator: Locator,
  timeout = 10_000,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    await locator.first().click();
    return true;
  } catch {
    return false;
  }
}

// Drive the cloud entry point of first-run: the transcript's Eliza Cloud option,
// then the SensitiveRequestBlock "Connect Eliza Cloud" OAuth authorize
// affordance if shown.
async function chooseCloudRuntime(page: Page): Promise<void> {
  await clickIfVisible(
    page.getByTestId("choice-__first_run__:runtime:cloud"),
    30_000,
  );
  await clickIfVisible(
    page.getByTestId("sensitive-request-oauth-start"),
    5_000,
  );
}

async function readActiveServer(page: Page): Promise<{
  kind?: string;
  apiBase?: string;
} | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("elizaos:active-server");
    return raw
      ? (JSON.parse(raw) as { kind?: string; apiBase?: string })
      : null;
  });
}

async function waitForProvisioningOutcome(
  page: Page,
): Promise<"cloud" | "retry"> {
  let outcome: "cloud" | "retry" | "pending" = "pending";
  await expect
    .poll(
      async () => {
        const active = await readActiveServer(page);
        if (active?.kind === "cloud") outcome = "cloud";
        else if (
          await page.getByTestId("choice-__first_run__:error:retry").isVisible()
        )
          outcome = "retry";
        return outcome;
      },
      { timeout: PROVISION_ATTEMPT_TIMEOUT_MS },
    )
    .not.toBe("pending");
  return outcome;
}

test.describe("real cloud login + provisioning + chat", () => {
  test.setTimeout(420_000);
  test.skip(
    !CLOUD_LIVE_ENABLED,
    "set ELIZA_UI_SMOKE_CLOUD_LIVE=1 and ELIZA_UI_SMOKE_LIVE_STACK=1 to run against real Eliza Cloud",
  );
  test.skip(
    !HAS_CLOUD_KEY,
    "set ELIZAOS_CLOUD_API_KEY to authenticate to real Eliza Cloud",
  );

  test("provisions a real cloud agent from onboarding and chats with it", async ({
    page,
  }) => {
    expect(
      await seedCloudLiveBrowserAuth(page),
      "Cloud-live mode must hand its validated workflow bearer to the browser",
    ).toBe(true);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for the in-chat first-run surface: #9952 onboarding IS the chat, so
    // the seeded greeting + runtime choice render inside the floating overlay.
    await expect(page.getByTestId("chat-overlay")).toBeVisible({
      timeout: 60_000,
    });

    await chooseCloudRuntime(page);

    // Real provisioning (create -> provision -> poll jobs -> launch) persists a
    // cloud active-server with the provisioned agent's bridge URL. This only
    // succeeds if real login + provisioning actually completed. Retry once
    // through the product's explicit recovery choice when a transient Cloud
    // request fails; a repeated error remains a hard failure.
    for (let attempt = 1; attempt <= PROVISION_ATTEMPTS; attempt += 1) {
      const outcome = await waitForProvisioningOutcome(page);
      if (outcome === "cloud") break;
      if (attempt === PROVISION_ATTEMPTS) {
        throw new Error(
          `Eliza Cloud provisioning requested retry ${PROVISION_ATTEMPTS} times`,
        );
      }
      await page.getByTestId("choice-__first_run__:error:retry").click();
    }
    const active = await readActiveServer(page);
    expect(active?.kind).toBe("cloud");
    expect(
      active?.apiBase,
      "provisioned cloud agent must expose a bridge URL",
    ).toBeTruthy();

    // In cloud-only mode (#13377, the default) provisioning success completes
    // onboarding by itself and no tutorial choice is seeded. Under the
    // dev-only runtime chooser, completion is deferred to the tutorial-or-skip
    // pick — tolerate both: skip the tour if it is offered, else proceed.
    await clickIfVisible(
      page.getByTestId("choice-__first_run__:tutorial:skip"),
      15_000,
    );

    // Real chat turn against the provisioned cloud agent — the shared liveness
    // contract (#14359) proves a real model answered (non-empty, no stub marker).
    await openAppPath(page, "/chat");
    await assertOnboardingLiveness(page, { label: "cloud-live" });
  });
});
