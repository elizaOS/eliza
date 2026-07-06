// Opt-in REAL cloud e2e: real login + real provisioning + real cloud chat,
// through the app UI, against real Eliza Cloud. This is the un-mocked counterpart
// to cloud-provisioning-startup.spec.ts (which asserts the UI against page.route
// fixtures). NOTHING here mocks a cloud endpoint — the requests hit the live
// stack, which proxies /api/cloud/* to real cloud-api.
//
// Requirements (all enforced by the skip guard below; the gated app-live-e2e.yml
// lane supplies them):
//   - ELIZA_UI_SMOKE_CLOUD_LIVE=1  → the live stack leaves first-run UNcompleted
//     so this spec can drive cloud onboarding through the UI.
//   - ELIZA_UI_SMOKE_LIVE_STACK=1  → the live stack boots the real app-core
//     runtime instead of the deterministic stub (shouldForceStubStack).
//   - ELIZAOS_CLOUD_API_KEY        → real cloud credential; the app treats cloud
//     as connected, so no interactive OAuth window is needed.
//
// It must NEVER run in a keyless PR lane: it spends real cloud credits and needs
// secrets. It is classified LIVE_ONLY in ui-smoke-coverage.test.ts and is wired
// only into the nightly/dispatch app-live-e2e.yml workflow.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { assertOnboardingLiveness } from "../liveness-contract";
import { openAppPath, seedAppStorage } from "./helpers";

const CLOUD_LIVE_ENABLED =
  process.env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1" &&
  process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const HAS_CLOUD_KEY = Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim());

const PROVISION_TIMEOUT_MS = 180_000;

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

test.describe("real cloud login + provisioning + chat", () => {
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
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for the in-chat first-run surface: #9952 onboarding IS the chat, so
    // the seeded greeting + runtime choice render inside the floating overlay.
    await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
      timeout: 60_000,
    });

    await chooseCloudRuntime(page);

    // Real provisioning (create -> provision -> poll jobs -> launch) persists a
    // cloud active-server with the provisioned agent's bridge URL. This only
    // succeeds if real login + provisioning actually completed.
    await expect
      .poll(() => readActiveServer(page).then((s) => s?.kind ?? null), {
        timeout: PROVISION_TIMEOUT_MS,
      })
      .toBe("cloud");
    const active = await readActiveServer(page);
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
