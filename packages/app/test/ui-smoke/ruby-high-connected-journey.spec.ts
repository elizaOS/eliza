/**
 * Connected-agent proof for Ruby High's complete elizaOS journey.
 *
 * The lane installs the published package from the exact generated registry,
 * invokes its real published actions through the local runtime action registry,
 * completes Ruby High's approval-bound device flow in a browser session,
 * enrolls the connected agent, launches its scoped school viewer, and advances
 * that same agent through grades 9–12 using Ruby High's development accelerator.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type FrameLocator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const REAL_LOCAL_STACK = process.env.ELIZA_UI_SMOKE_REAL_LOCAL_STACK === "1";
const RUBY_HIGH_JOURNEY = process.env.ELIZA_UI_SMOKE_RUBY_HIGH_JOURNEY === "1";
const REGISTRY_FIXTURE =
  process.env.ELIZA_UI_SMOKE_GENERATED_REGISTRY_FIXTURE?.trim();
const RUBY_HIGH_URL = (
  process.env.RUBY_HIGH_URL ?? "http://127.0.0.1:3100"
).replace(/\/$/, "");
const APP_NAME = "@rati-osf/plugin-ruby-high";
const VIEWER_PATH = "/ruby-high/viewer";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const RECORDING_PAUSE_MS = process.env.E2E_RECORD ? 1_250 : 0;

type ConnectedStatus = {
  connection?: {
    connected?: boolean;
    baseUrl?: string;
    pending?: {
      userCode?: string;
      verificationUriComplete?: string;
    } | null;
  };
  state?: {
    student?: {
      name?: string;
      currentGrade?: string | null;
    } | null;
  } | null;
};

type EvidenceActionResponse = {
  ok?: boolean;
  actionName?: string;
  callbacks?: string[];
  result?: {
    success?: boolean;
    text?: string;
    data?: Record<string, unknown>;
  };
};

async function pauseForReview(page: Page, milliseconds = RECORDING_PAUSE_MS) {
  if (milliseconds > 0) await page.waitForTimeout(milliseconds);
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.jpg`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: screenshotPath,
    type: "jpeg",
    quality: 92,
    fullPage: true,
    attempts: 4,
  });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/jpeg",
  });
}

async function invokeRubyHighAction(
  page: Page,
  actionName: "CONNECT_RUBY_HIGH" | "ENROLL_RUBY_HIGH",
  parameters: Record<string, unknown> = {},
): Promise<EvidenceActionResponse> {
  const response = await page.request.post("/api/device-e2e/ruby-high/action", {
    data: { actionName, parameters },
  });
  const responseText = await response.text();
  expect(
    response.ok(),
    `${actionName} failed: ${response.status()} ${responseText}`,
  ).toBe(true);
  const body = JSON.parse(responseText) as EvidenceActionResponse;
  expect(body).toMatchObject({
    ok: true,
    actionName,
    result: { success: true },
  });
  return body;
}

async function readStatus(page: Page): Promise<ConnectedStatus> {
  const response = await page.request.get("/ruby-high/status");
  const responseText = await response.text();
  expect(
    response.ok(),
    `Ruby High status failed: ${response.status()} ${responseText}`,
  ).toBe(true);
  return JSON.parse(responseText) as ConnectedStatus;
}

async function bootstrapHumanSchoolSession(
  page: Page,
  rubyHighOrigin: string,
): Promise<void> {
  await page.goto(`${rubyHighOrigin}/api/apps/ruby-high/viewer`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveTitle(/Ruby High/);
  await expect(page.locator("#shell")).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async () => {
    const response = await fetch(
      "/api/apps/ruby-high/session/eliza-evidence-human/command",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "mark-intro-seen" }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `human session bootstrap failed: ${await response.text()}`,
      );
    }
  });
  await expect
    .poll(
      async () =>
        (await page.context().cookies(rubyHighOrigin)).some(
          (cookie) => cookie.name === "rh_session",
        ),
      { message: "Ruby High human approval session cookie was not persisted" },
    )
    .toBe(true);
  await pauseForReview(page);
}

async function approveAgent(
  page: Page,
  verificationUriComplete: string,
  userCode: string,
): Promise<void> {
  await page.goto(verificationUriComplete, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Agent enrollment" }),
  ).toBeVisible();
  await expect(page.locator("#code")).toHaveValue(userCode);
  await pauseForReview(page);
  await page.getByRole("button", { name: "Approve agent" }).click();
  await expect(page.getByRole("status")).toContainText(
    "may now return to its device",
  );
  await pauseForReview(page);
}

async function installAndOpenRubyHigh(page: Page): Promise<FrameLocator> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/apps");
        if (!response.ok()) return false;
        const catalog = (await response.json()) as Array<{ name?: string }>;
        return catalog.some((app) => app.name === APP_NAME);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await openAppPath(page, "/views");
  await expect(page.getByTestId("launcher")).toBeVisible({ timeout: 60_000 });
  const tile = page.getByRole("button", { name: "Ruby High" });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  await tile.scrollIntoViewIfNeeded();
  const launchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/apps/launch",
    { timeout: 300_000 },
  );
  await tile.click();
  expect((await launchResponse).ok()).toBe(true);
  const iframe = page.getByTestId("game-view-iframe");
  await expect(iframe).toBeVisible({ timeout: 60_000 });
  const frame = page.frameLocator('[data-testid="game-view-iframe"]');
  await expect(frame.getByRole("heading", { name: "Ruby High" })).toBeVisible({
    timeout: 60_000,
  });
  return frame;
}

async function reloadViewer(page: Page): Promise<FrameLocator> {
  const iframe = page.getByTestId("game-view-iframe");
  await iframe.evaluate((element) => {
    const frame = element as HTMLIFrameElement;
    frame.contentWindow?.location.reload();
  });
  const viewer = page.frameLocator('[data-testid="game-view-iframe"]');
  await expect(viewer.getByRole("heading", { name: "Ruby High" })).toBeVisible({
    timeout: 60_000,
  });
  return viewer;
}

async function expectViewerGrade(
  viewer: FrameLocator,
  grade: string,
): Promise<void> {
  await expect(viewer.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    viewer.getByText("ElizaOS Agent", { exact: true }),
  ).toBeVisible();
  const gradeValue = viewer
    .locator("dt", { hasText: "Grade" })
    .locator("xpath=following-sibling::dd[1]");
  await expect(gradeValue).toHaveText(grade);
}

async function launchAgentSchool(page: Page): Promise<void> {
  const response = await page.request.post("/ruby-high/launch", { data: {} });
  const responseText = await response.text();
  expect(
    response.ok(),
    `agent school launch failed: ${response.status()} ${responseText}`,
  ).toBe(true);
  const body = JSON.parse(responseText) as { launchUrl?: string };
  expect(body.launchUrl).toBeTruthy();
  await page.goto(body.launchUrl ?? "", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/api\/apps\/ruby-high\/viewer/);
  await expect(page.locator("#shell")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#you-name")).toHaveText("ElizaOS Agent", {
    timeout: 60_000,
  });
  const announcements = page.locator("#announcements-overlay");
  if (await announcements.isVisible().catch(() => false)) {
    await page.locator("#announcements-dismiss").click();
    await expect(announcements).not.toBeVisible();
  }
  await pauseForReview(page, process.env.E2E_RECORD ? 3_500 : 0);
}

async function advanceGrade(
  page: Page,
): Promise<{ completedGrade?: string; currentGrade?: string | null }> {
  const response = await page.request.post(`${RUBY_HIGH_URL}/dev/tick-grade`, {
    data: {},
  });
  const responseText = await response.text();
  expect(
    response.ok(),
    `grade advance failed: ${response.status()} ${responseText}`,
  ).toBe(true);
  return JSON.parse(responseText) as {
    completedGrade?: string;
    currentGrade?: string | null;
  };
}

test.describe("Ruby High connected elizaOS agent journey", () => {
  test.skip(!REAL_LOCAL_STACK, "requires ELIZA_UI_SMOKE_REAL_LOCAL_STACK=1");
  test.skip(!RUBY_HIGH_JOURNEY, "requires the scripted Ruby High action lane");
  test.skip(!REGISTRY_FIXTURE, "requires the exact-head registry fixture");
  test.setTimeout(600_000);

  test("connects, approves, enrolls, and advances the same agent through grades", async ({
    page,
  }, testInfo) => {
    const consoleLines: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const httpErrors: string[] = [];
    page.on("console", (message) => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) =>
      pageErrors.push(error.stack ?? error.message),
    );
    page.on("requestfailed", (request) => {
      requestFailures.push(
        `${request.method()} ${request.url()} — ${
          request.failure()?.errorText ?? "unknown error"
        }`,
      );
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await seedAppStorage(page);
    let viewer = await installAndOpenRubyHigh(page);
    await expect(
      viewer.getByText("Needs connection", { exact: true }),
    ).toBeVisible();
    await pauseForReview(page);

    const connectionStarted = await invokeRubyHighAction(
      page,
      "CONNECT_RUBY_HIGH",
    );
    const pending = connectionStarted.result?.data?.pending as
      | { userCode?: string; verificationUriComplete?: string }
      | undefined;
    const userCode = pending?.userCode;
    const verificationUriComplete = pending?.verificationUriComplete;
    expect(userCode).toBeTruthy();
    expect(verificationUriComplete).toBeTruthy();
    const verificationOrigin = new URL(verificationUriComplete ?? "").origin;
    expect(verificationOrigin).toBe(new URL(RUBY_HIGH_URL).origin);

    await bootstrapHumanSchoolSession(page, verificationOrigin);
    await approveAgent(page, verificationUriComplete ?? "", userCode ?? "");
    await capture(page, testInfo, "approval-bound-agent-connection");

    const connectionCompleted = await invokeRubyHighAction(
      page,
      "CONNECT_RUBY_HIGH",
    );
    expect(connectionCompleted.result?.data).toMatchObject({
      connected: true,
    });
    const enrollment = await invokeRubyHighAction(page, "ENROLL_RUBY_HIGH", {
      name: "ElizaOS Agent",
      playbookId: "outsider",
    });
    expect(enrollment.result?.text).toBe(
      "Enrolled ElizaOS Agent at Ruby High.",
    );

    const connectedStatus = await readStatus(page);
    expect(connectedStatus).toMatchObject({
      connection: {
        connected: true,
        baseUrl: RUBY_HIGH_URL,
      },
      state: {
        student: {
          name: "ElizaOS Agent",
          currentGrade: "9",
        },
      },
    });

    viewer = await installAndOpenRubyHigh(page);
    await expectViewerGrade(viewer, "9");
    await capture(page, testInfo, "connected-enrolled-grade-9");
    await pauseForReview(page);

    await launchAgentSchool(page);
    await capture(page, testInfo, "connected-agent-school-launch");
    await openAppPath(page, "/views");
    viewer = await installAndOpenRubyHigh(page);
    await expectViewerGrade(viewer, "9");

    const progression: Array<{
      completedGrade?: string;
      currentGrade?: string | null;
    }> = [];
    for (const grade of ["10", "11", "12"]) {
      progression.push(await advanceGrade(page));
      viewer = await reloadViewer(page);
      await expectViewerGrade(viewer, grade);
      await capture(page, testInfo, `connected-agent-grade-${grade}`);
      await pauseForReview(page);
    }

    expect(progression).toEqual([
      expect.objectContaining({ completedGrade: "9", currentGrade: "10" }),
      expect.objectContaining({ completedGrade: "10", currentGrade: "11" }),
      expect.objectContaining({ completedGrade: "11", currentGrade: "12" }),
    ]);

    const finalStatus = await readStatus(page);
    expect(finalStatus).toMatchObject({
      connection: { connected: true },
      state: {
        student: {
          name: "ElizaOS Agent",
          currentGrade: "12",
        },
      },
    });

    const frontendEvidence = {
      appName: APP_NAME,
      rubyHighUrl: RUBY_HIGH_URL,
      viewerPath: VIEWER_PATH,
      actions: {
        connectionStarted,
        connectionCompleted,
        enrollment,
      },
      connectedStatus,
      progression,
      finalStatus,
      finalUrl: page.url(),
      consoleLines,
      pageErrors,
      requestFailures,
      httpErrors,
    };
    const frontendLogPath = testInfo.outputPath("frontend-and-network.json");
    await writeFile(
      frontendLogPath,
      `${JSON.stringify(frontendEvidence, null, 2)}\n`,
      "utf8",
    );
    await testInfo.attach("frontend and network log", {
      path: frontendLogPath,
      contentType: "application/json",
    });

    const backendLogSetting =
      process.env.ELIZA_UI_SMOKE_BACKEND_LOG_PATH?.trim();
    expect(backendLogSetting).toBeTruthy();
    const backendLogPath = path.resolve(
      REPO_ROOT,
      backendLogSetting ?? "e2e-recordings/ruby-high-connected/backend.log",
    );
    const backendLog = await readFile(backendLogPath, "utf8");
    expect(backendLog).toContain("serving generated registry fixture");
    expect(backendLog).toContain(
      `[app-manager] Installing plugin for app: ${APP_NAME}`,
    );
    expect(backendLog).toContain(
      `[app-manager] Plugin installed: ${APP_NAME} v0.1.5`,
    );
    expect(backendLog).not.toContain("[plugin-installer] npm failed");
    await testInfo.attach("backend log", {
      path: backendLogPath,
      contentType: "text/plain",
    });

    expect(pageErrors, "no uncaught frontend errors").toEqual([]);
    expect(
      httpErrors.filter(
        (line) =>
          line.includes("ruby-high") &&
          !line.startsWith("428 POST") &&
          !line.includes("/assets/favicon"),
      ),
      "no unexpected Ruby High HTTP errors",
    ).toEqual([]);
  });
});
