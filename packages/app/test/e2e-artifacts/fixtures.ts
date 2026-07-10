/**
 * Playwright test fixtures that feed the per-test artifact bundle (#15972).
 * Specs import `test`/`expect` from here instead of `@playwright/test` and get,
 * automatically: timestamped JSONL console + network logs attached at test end,
 * a `statecap(name)` helper for named full-page state screenshots, the
 * `window.__ELIZA_E2E` handshake the app-side PostHog session-capture module
 * reads, and trajectory JSON pickup from `ELIZA_TRAJECTORY_DIR`.
 *
 * Everything is delivered through `testInfo.attach` under the naming
 * conventions `./reporter.ts` classifies (`console-log`, `network-log`,
 * `state:<name>`, `trajectory:<file>`), so the bundle only materializes when
 * the reporter is wired in (`ELIZA_E2E_ARTIFACTS`); default runs still record
 * the attachments in Playwright's own report and change nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { buildTestId, resolveLane } from "./ids";

interface ConsoleEvent {
  ts: string;
  type: string;
  text: string;
  location: string;
}

interface NetworkEvent {
  ts: string;
  phase: "request" | "response" | "failed";
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
}

function toJsonl(events: readonly object[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

interface ArtifactFixtures {
  /** Attach a named full-page screenshot of the current UI state. */
  statecap: (name: string) => Promise<void>;
  artifactCapture: void;
}

export const test = base.extend<ArtifactFixtures>({
  // Auto fixture: wraps every test, so the listeners are installed before the
  // spec body runs and the logs are attached after it finishes (pass or fail).
  artifactCapture: [
    async ({ page }, use, testInfo) => {
      const consoleEvents: ConsoleEvent[] = [];
      const networkEvents: NetworkEvent[] = [];

      page.on("console", (message) => {
        const location = message.location();
        consoleEvents.push({
          ts: new Date().toISOString(),
          type: message.type(),
          text: message.text(),
          location: `${location.url}:${location.lineNumber}:${location.columnNumber}`,
        });
      });
      page.on("request", (request) => {
        networkEvents.push({
          ts: new Date().toISOString(),
          phase: "request",
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
        });
      });
      page.on("response", (response) => {
        networkEvents.push({
          ts: new Date().toISOString(),
          phase: "response",
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
          resourceType: response.request().resourceType(),
        });
      });
      page.on("requestfailed", (request) => {
        networkEvents.push({
          ts: new Date().toISOString(),
          phase: "failed",
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
        });
      });

      // The app-side session-capture module
      // (packages/app/src/analytics/e2e-session-capture.ts) reads
      // window.__ELIZA_E2E at boot to route PostHog traffic per test; the init
      // script must be registered before the spec navigates anywhere, which is
      // exactly what an auto fixture guarantees.
      const posthogHost = process.env.ELIZA_E2E_POSTHOG_HOST;
      if (posthogHost) {
        const testId = buildTestId(
          resolveLane(),
          testInfo.file,
          testInfo.titlePath,
        );
        await page.addInitScript(
          (handshake) => {
            (
              window as Window & {
                __ELIZA_E2E?: { testId: string; posthogHost: string };
              }
            ).__ELIZA_E2E = handshake;
          },
          { testId, posthogHost },
        );
      }

      const startedAtMs = Date.now();
      await use();

      await testInfo.attach("console-log", {
        body: toJsonl(consoleEvents),
        contentType: "application/jsonl",
      });
      await testInfo.attach("network-log", {
        body: toJsonl(networkEvents),
        contentType: "application/jsonl",
      });

      // Trajectory pickup: any trajectory JSON the agent wrote during this
      // test's window belongs to this test's bundle. Attached (not copied
      // directly) so the reporter remains the only writer under the run root.
      const trajectoryDir = process.env.ELIZA_TRAJECTORY_DIR;
      if (trajectoryDir && fs.existsSync(trajectoryDir)) {
        for (const entry of fs.readdirSync(trajectoryDir).sort()) {
          if (!entry.endsWith(".json")) continue;
          const filePath = path.join(trajectoryDir, entry);
          const stat = fs.statSync(filePath);
          if (!stat.isFile() || stat.mtimeMs < startedAtMs) continue;
          await testInfo.attach(`trajectory:${entry}`, {
            path: filePath,
            contentType: "application/json",
          });
        }
      }
    },
    { auto: true },
  ],

  statecap: async ({ page }, use, testInfo) => {
    await use(async (name: string) => {
      const body = await page.screenshot({ fullPage: true });
      await testInfo.attach(`state:${name}`, {
        body,
        contentType: "image/png",
      });
    });
  },
});

export { expect };
