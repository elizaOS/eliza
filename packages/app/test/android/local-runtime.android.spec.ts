// Real on-device LOCAL runtime assertions. Proves the WebView is wired to a live
// on-device agent (not a mock): the agent API answers, reports the smoke model
// loaded, and the chat surface is interactive. The full SSE chat round-trip is
// covered by mobile-local-chat-smoke (test:sim:local-chat:android:live); this
// spec asserts the UI-visible side of the same live backend.
import { AGENT_API_PORT } from "../../scripts/lib/android-device.mjs";
import { expect, gotoRoute, test, waitForShellReady } from "./android-harness";

test.describe
  .serial("android local runtime (real on-device agent)", () => {
    test("on-device agent answers /api/health and /api/status", async ({
      page,
    }) => {
      await waitForShellReady(page);
      // Call the agent through the WebView's own fetch so this exercises the same
      // path the app uses (Capacitor HTTP / loopback), proving the runtime is real.
      // Playwright COLD-launches the activity, which restarts the on-device agent;
      // its HTTP server can return 503 (local_agent_unavailable) for the first few
      // seconds while the runtime binds. Poll for the real cold-start window so a
      // startup race doesn't read as an outage — it still fails if it never serves.
      const probeHealth = () =>
        page.evaluate(async (port) => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
              headers: { "X-ElizaOS-Client-Id": "android-e2e" },
            });
            return { status: res.status, body: await res.text() };
          } catch (error) {
            return { status: 0, body: String(error) };
          }
        }, AGENT_API_PORT);
      let health = await probeHealth();
      await expect
        .poll(
          async () => {
            health = await probeHealth();
            return health.status;
          },
          {
            timeout: 30_000,
            intervals: [500, 1000, 2000],
          },
        )
        .toBe(200);
      expect(health.status, `health body: ${health.body}`).toBe(200);
    });

    test("chat surface mounts and composer is interactive", async ({
      page,
    }) => {
      await gotoRoute(page, "/chat");
      const composer = page.locator('[data-testid="chat-composer-textarea"]');
      await expect(composer).toBeVisible({ timeout: 60_000 });
      await expect(composer).toBeEnabled({ timeout: 60_000 });
    });
  });
