/**
 * Exercises real login, provisioning, and chat through the app UI against
 * Eliza Cloud, without mocking cloud endpoints. The opt-in workflow must supply
 * both live-stack flags and ELIZAOS_CLOUD_API_KEY; this test spends real cloud
 * credits and must never run in a keyless PR lane.
 */

import { resolveDirectCloudAuthApiBase } from "@elizaos/ui/api/direct-cloud-endpoints";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { seedCloudLiveBrowserAuth } from "../cloud-live-browser-auth";
import { resolveCloudLiveOriginContract } from "../cloud-live-origin";
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
    // #18076: prove which Cloud deployment this lane targets BEFORE any
    // auth/provision/chat traffic. When the workflow pins an expected
    // environment (staging/production), a defaulted or mismatched origin is a
    // hard failure — never a silent fall-through to production.
    const originContract = resolveCloudLiveOriginContract(process.env);
    test.info().annotations.push(
      { type: "cloud-api-origin", description: originContract.origin },
      { type: "cloud-environment", description: originContract.environment },
      {
        // This lane always drives the renderer bundle built from the checked-out
        // revision through the live stack; it does NOT drive a deployed Pages
        // artifact. Recorded so run artifacts state what was exercised.
        type: "renderer-source",
        description: "locally built renderer bundle (not a deployed artifact)",
      },
    );
    expect(
      originContract.ok,
      originContract.reason ??
        `resolved Cloud API origin: ${originContract.origin}`,
    ).toBe(true);

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

    // The process-level contract above only pins the spawned runtime's proxy.
    // The renderer carries its own Cloud base, resolved at BUILD time from
    // VITE_ELIZA_CLOUD_BASE and otherwise defaulted, and the shared-agent base
    // for the chat leg is derived from it
    // (client-cloud.ts buildCloudSharedAgentApiBase). A bundle built for the
    // wrong deployment therefore talks to the wrong Cloud with this lane's
    // bearer. Compare through resolveDirectCloudAuthApiBase because the boot
    // value is a SITE base ("https://eliza.app") while the contract exposes an
    // API origin ("https://api.eliza.app") -- equivalent, differently spelled.
    const rendererCloudBase = await page.evaluate(() => {
      const config = (
        window as unknown as {
          __ELIZAOS_APP_BOOT_CONFIG__?: { cloudApiBase?: string };
        }
      ).__ELIZAOS_APP_BOOT_CONFIG__;
      return config?.cloudApiBase ?? "";
    });
    const rendererApiOrigin = (() => {
      if (!rendererCloudBase) return "";
      try {
        return new URL(resolveDirectCloudAuthApiBase(rendererCloudBase)).origin;
      } catch {
        // error-policy:J3 a malformed boot value is reported as an explicit
        // mismatch carrying the offending string, never as a raw TypeError.
        return `<unparseable: ${rendererCloudBase}>`;
      }
    })();
    test.info().annotations.push({
      type: "renderer-cloud-origin",
      description: rendererApiOrigin,
    });
    expect(
      rendererApiOrigin,
      `renderer bundle resolves ${rendererCloudBase || "<unset>"} -> ${rendererApiOrigin || "<empty>"}; the lane pinned ${originContract.origin}`,
    ).toBe(originContract.origin);

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
