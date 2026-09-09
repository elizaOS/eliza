/** Exercises the real chooser and Cloud continuation across delayed native storage acknowledgements; host/auth/network are contained fixtures, not device or provider acceptance. */
import { expect, test } from "@playwright/test";
import { seedAppStorage } from "./helpers";
import { setStewardSession } from "./helpers/test-auth";
import {
  dismissPermissionPrimingIfShown,
  expectChatFirstOnboarding,
  injectCloudAuthToken,
  injectFullCapabilityHost,
  installCloudRoutes,
  installHomeRoutes,
  RUNTIME_CHOICE,
  TUTORIAL_CHOICE,
} from "./onboarding-to-home.shared";

for (const scenario of [
  "success",
  "rejected",
  "pagehide",
  "session-change",
] as const) {
  test(`Cloud choice waits for native local cleanup: ${scenario}`, async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1")
      throw new Error(
        "This contained renderer test requires a loopback server",
      );
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin === baseURL &&
        request.method() === "GET" &&
        (request.isNavigationRequest() ||
          url.pathname === "/api/first-run/options" ||
          !/^\/(api|auth|steward)\//.test(url.pathname))
      ) {
        await route.fulfill({
          response: await route.fetch({ maxRedirects: 0 }),
        });
      } else await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await injectFullCapabilityHost(page);
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    let deleteEntered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.exposeFunction("__waitForFixtureNativeDelete", async () => {
      deleteEntered = true;
      await gate;
      return scenario !== "rejected";
    });
    await page.addInitScript(() => {
      const host = window as unknown as {
        __waitForFixtureNativeDelete(): Promise<boolean>;
        __ELIZA_ELECTROBUN_RPC__: {
          request: {
            secureStoreDelete(args: {
              kind: string;
            }): Promise<{ ok: boolean; reason?: string; deleted?: boolean }>;
          };
        };
      };
      const request = host.__ELIZA_ELECTROBUN_RPC__.request;
      const original = request.secureStoreDelete;
      request.secureStoreDelete = async (args) => {
        if (
          args.kind === "runtime.active_server" &&
          !(await host.__waitForFixtureNativeDelete())
        )
          return { ok: false, reason: "denied" };
        return original(args);
      };
    });
    let identityReads = 0;
    await page.route("**/api/v1/eliza/personal", async (route) => {
      identityReads++;
      await route.fallback();
    });
    try {
      await page.goto("/");
      await expectChatFirstOnboarding(page);
      const cloud = page.getByTestId(RUNTIME_CHOICE("cloud"));
      await cloud.click();
      await expect.poll(() => deleteEntered).toBe(true);
      expect(identityReads).toBe(0);
      await page.waitForTimeout(1200);
      await page.screenshot({
        path: testInfo.outputPath("cleanup-wait-fullpage.jpg"),
        fullPage: true,
      });
      if (scenario === "pagehide")
        await page.evaluate(() =>
          window.dispatchEvent(
            new PageTransitionEvent("pagehide", { persisted: true }),
          ),
        );
      if (scenario === "session-change")
        await setStewardSession(page, {
          token: "replacement-onboarding-fixture-token",
        });
      release();
      if (scenario === "success") {
        const tutorial = page.getByTestId(TUTORIAL_CHOICE("skip"));
        await expect(tutorial).toBeVisible({ timeout: 30_000 });
        await tutorial.click();
        await dismissPermissionPrimingIfShown(page);
        await expect(page.getByTestId("home-screen")).toBeVisible();
        await expect(page.getByTestId("chat-composer-textarea")).toBeEnabled();
        expect(identityReads).toBe(1);
      } else {
        if (scenario !== "pagehide")
          await expect(
            page.getByTestId("choice-__first_run__:error:retry"),
          ).toBeVisible({ timeout: 15_000 });
        // Re-read through the renderer's real protected-storage cache after
        // rollback. A stale cleanup must not publish the joined Cloud target.
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                JSON.parse(
                  localStorage.getItem("elizaos:active-server") || "null",
                )?.kind,
            ),
          )
          .toBe("local");
        expect(identityReads).toBe(0);
        await expect(page.getByTestId(TUTORIAL_CHOICE("skip"))).toHaveCount(0);
        if (scenario === "pagehide") {
          await page.evaluate(() =>
            window.dispatchEvent(
              new PageTransitionEvent("pageshow", { persisted: true }),
            ),
          );
          const retry = page.getByTestId("choice-__first_run__:error:retry");
          await expect(retry).toBeVisible();
          await retry.click();
          const tutorial = page.getByTestId(TUTORIAL_CHOICE("skip"));
          await expect(tutorial).toBeVisible({ timeout: 30_000 });
          await tutorial.click();
          await dismissPermissionPrimingIfShown(page);
          await expect(page.getByTestId("home-screen")).toBeVisible();
          await expect(
            page.getByTestId("chat-composer-textarea"),
          ).toBeEnabled();
          expect(identityReads).toBe(1);
        }
      }
      await page.waitForTimeout(1200);
      await page.screenshot({
        path: testInfo.outputPath("terminal-fullpage.jpg"),
        fullPage: true,
      });
      expect(state.firstRunPosts).toHaveLength(0);
      expect(pageErrors).toEqual([]);
    } finally {
      release();
    }
  });
}
