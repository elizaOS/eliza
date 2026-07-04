import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type JsonRecord = Record<string, unknown>;

const ACTIVE_SESSION = {
  id: "screen-smoke-1",
  label: "This machine",
  status: "active",
  createdAt: "2026-05-31T10:00:00.000Z",
  updatedAt: "2026-05-31T10:00:01.000Z",
  stoppedAt: null,
  platform: "linux",
  frameCount: 3,
  inputCount: 2,
  lastFrameAt: "2026-05-31T10:00:01.000Z",
  lastInputAt: "2026-05-31T10:00:02.000Z",
};

const STOPPED_SESSION = {
  ...ACTIVE_SESSION,
  status: "stopped",
  stoppedAt: "2026-05-31T10:00:03.000Z",
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function readJson(route: Route): JsonRecord {
  const raw = route.request().postData();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

async function installScreenshareRoutes(page: Page) {
  let capabilitiesRequests = 0;
  const startRequests: JsonRecord[] = [];
  const stopRequests: JsonRecord[] = [];

  await page.route("**/api/apps/screenshare/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (
      method === "GET" &&
      url.pathname === "/api/apps/screenshare/capabilities"
    ) {
      capabilitiesRequests += 1;
      await fulfillJson(route, {
        platform: "linux",
        capabilities: {
          screenshot: { available: true, tool: "playwright-frame" },
          headfulGui: { available: true, tool: "playwright-gui" },
          keyboard: { available: true, tool: "playwright-input" },
          mouse: { available: false, tool: "unavailable" },
        },
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/apps/screenshare/session") {
      startRequests.push(readJson(route));
      await fulfillJson(route, {
        session: ACTIVE_SESSION,
        token: "screen-token-1",
        viewerUrl:
          "/api/apps/screenshare/viewer?sessionId=screen-smoke-1&token=screen-token-1",
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname === "/api/apps/screenshare/session/screen-smoke-1/stop"
    ) {
      stopRequests.push(readJson(route));
      expect(route.request().headers()["x-screenshare-token"]).toBe(
        "screen-token-1",
      );
      await fulfillJson(route, { session: STOPPED_SESSION });
      return;
    }

    await route.fallback();
  });

  return {
    capabilitiesRequests: () => capabilitiesRequests,
    startRequests: () => startRequests.slice(),
    stopRequests: () => stopRequests.slice(),
  };
}

test.beforeEach(async ({ page }) => {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await installDefaultAppRoutes(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("screenshare GUI drives host lifecycle, copied details, remote connect, and capability refresh", async ({
  page,
}) => {
  const recorder = await installScreenshareRoutes(page);

  await page.addInitScript(() => {
    const target = window as Window & {
      __screenshareOpenedUrls?: string[];
      __screenshareClipboardWrites?: string[];
    };
    target.__screenshareOpenedUrls = [];
    target.__screenshareClipboardWrites = [];
    window.open = (url) => {
      target.__screenshareOpenedUrls?.push(String(url));
      return null;
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          target.__screenshareClipboardWrites?.push(value);
        },
      },
    });
  });

  await openAppPath(page, "/screenshare");

  await expect(page.getByText(/^Session:/)).toBeVisible();
  // The operator ScreenshareView embeds the presentational ScreenshareSpatialView,
  // so two "Start host session" buttons render (the operator toggle
  // `screenshare-session-toggle` and the spatial view's `start`). Target the
  // operator toggle explicitly to drive the host lifecycle unambiguously.
  const hostSessionToggle = page.locator(
    '[data-agent-id="screenshare-session-toggle"]',
  );
  await expect(hostSessionToggle).toBeVisible();
  await expect(hostSessionToggle).toContainText("Start host session");
  await expect(page.getByText("Capabilities", { exact: true })).toBeVisible();
  await expect(page.getByText("screenshot", { exact: true })).toBeVisible();
  await expect(page.getByText("keyboard", { exact: true })).toBeVisible();
  await expect(page.getByText("playwright-frame")).toBeVisible();
  await expect(page.getByText("playwright-input")).toBeVisible();

  await hostSessionToggle.click();
  await expect
    .poll(() => recorder.startRequests())
    .toEqual([{ label: "This machine" }]);
  await expect(page.getByText("Session: active")).toBeVisible();
  await expect(page.getByText("Frames: 3")).toBeVisible();
  await expect(page.getByText("Inputs: 2")).toBeVisible();

  await page.getByRole("button", { name: "Copy host details" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __screenshareClipboardWrites?: string[];
            }
          ).__screenshareClipboardWrites ?? [],
      ),
    )
    .toHaveLength(1);
  const copied = await page.evaluate(() =>
    JSON.parse(
      (
        window as Window & {
          __screenshareClipboardWrites?: string[];
        }
      ).__screenshareClipboardWrites?.[0] ?? "{}",
    ),
  );
  expect(copied).toMatchObject({
    sessionId: "screen-smoke-1",
    token: "screen-token-1",
  });

  await page.getByRole("button", { name: "Open host viewer" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __screenshareOpenedUrls?: string[];
            }
          ).__screenshareOpenedUrls ?? [],
      ),
    )
    .toContainEqual(
      expect.stringContaining(
        "/api/apps/screenshare/viewer?sessionId=screen-smoke-1&token=screen-token-1",
      ),
    );

  await page.getByPlaceholder("Server URL").fill("https://remote.example");
  await page.getByPlaceholder("Session").fill("remote-session");
  await page.getByPlaceholder("Token").fill("remote-token");
  // The remote-connect action lives in the embedded ScreenshareSpatialView and
  // is labelled just "Connect" (enabled once session id + token are set).
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __screenshareOpenedUrls?: string[];
            }
          ).__screenshareOpenedUrls ?? [],
      ),
    )
    .toContainEqual(
      "https://remote.example/api/apps/screenshare/viewer?sessionId=remote-session&token=remote-token&remoteBase=https%3A%2F%2Fremote.example",
    );

  const refreshesBefore = recorder.capabilitiesRequests();
  await page.getByRole("button", { name: "Refresh capabilities" }).click();
  await expect
    .poll(() => recorder.capabilitiesRequests())
    .toBeGreaterThan(refreshesBefore);

  // "Stop host session" also renders twice (operator toggle + the spatial
  // view's dedicated stop button); the operator toggle now reads "Stop host
  // session" while active, so drive it through the same stable toggle locator.
  await hostSessionToggle.click();
  await expect
    .poll(() => recorder.stopRequests())
    .toEqual([{ token: "screen-token-1" }]);
  await expect(page.getByText("Session: stopped")).toBeVisible();
});
