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

  await expect(page.getByRole("heading", { name: "Host" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Capabilities" }),
  ).toBeVisible();
  await expect(page.getByText("Screenshot")).toBeVisible();
  await expect(page.getByText("Keyboard")).toBeVisible();
  await expect(page.getByText("playwright-frame")).toBeVisible();
  await expect(page.getByText("playwright-input")).toBeVisible();

  await page.getByRole("button", { name: "Start host session" }).click();
  await expect
    .poll(() => recorder.startRequests())
    .toEqual([{ label: "This machine" }]);
  await expect(page.getByPlaceholder("Session").first()).toHaveValue(
    "screen…ke-1",
  );
  await expect(page.getByPlaceholder("Token").first()).toHaveValue("•••• en-1");
  await expect(page.getByText("3", { exact: true })).toBeVisible();
  await expect(page.getByText("2", { exact: true })).toBeVisible();

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
  await page.getByPlaceholder("Session").nth(1).fill("remote-session");
  await page.getByPlaceholder("Token").nth(1).fill("remote-token");
  await page.getByRole("button", { name: "Connect to remote" }).click();
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

  await page.getByRole("button", { name: "Stop host session" }).click();
  await expect
    .poll(() => recorder.stopRequests())
    .toEqual([{ token: "screen-token-1" }]);
  await expect(
    page.getByText("stopped", { exact: true }).first(),
  ).toBeVisible();
});
