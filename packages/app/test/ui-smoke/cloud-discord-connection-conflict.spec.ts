/**
 * Rendered Discord connection editor contract through the real Settings shell.
 * HTTP boundaries are deterministic; conflict, retry, responsive geometry, and
 * opaque edit-version payloads execute through production UI modules.
 */
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import {
  expectNoRenderTelemetryErrors,
  expectOnlyAllowedPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";
import { installCloudApiStubs } from "./helpers/cloud-audit-fixtures";
import { seedStewardSession } from "./helpers/test-auth";

const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const CHARACTER_ID = "44444444-4444-4444-8444-444444444444";
const CONCURRENT_CHARACTER_ID = "66666666-6666-4666-8666-666666666666";
const SYNTHETIC_TOKEN = "synthetic-ui-smoke-token-not-a-credential";

type RequestRecord = {
  method: string;
  path: string;
  status: number;
  body?: Record<string, unknown>;
};

const baseConnection = {
  id: CONNECTION_ID,
  applicationId: "discord-app",
  botUserId: "888888888888888888",
  characterId: CHARACTER_ID,
  status: "connected",
  errorMessage: null,
  guildCount: 2,
  eventsReceived: 41,
  eventsRouted: 39,
  isActive: true,
  metadata: {
    responseMode: "keyword",
    keywords: ["support"],
    enabledChannels: ["channel-allow"],
    disabledChannels: [] as string[],
    ownerDiscordUserId: "111111111111111",
    ownerDiscordUserIds: ["222222222222222", "333333333333333"],
    dmPolicy: "allowlist",
    dmAllowFrom: ["777777777777777"],
  },
  connectedAt: "2026-08-15T09:00:00.000Z",
  lastHeartbeat: "2026-08-15T11:00:00.000Z",
  createdAt: "2026-08-15T08:00:00.000Z",
  editVersion: "1",
};

type TestConnection = typeof baseConnection;

const openedConnection: TestConnection = {
  ...baseConnection,
  editVersion: "2",
};

const conflictedConnection: TestConnection = {
  ...baseConnection,
  characterId: CONCURRENT_CHARACTER_ID,
  isActive: false,
  metadata: {
    ...baseConnection.metadata,
    responseMode: "mention",
    disabledChannels: ["concurrent-channel-deny"],
    ownerDiscordUserId: "999999999999999",
    dmPolicy: "pairing",
    dmAllowFrom: ["666666666666666"],
  },
  editVersion: "3",
};

const repeatedConflictConnection: TestConnection = {
  ...conflictedConnection,
  metadata: {
    ...conflictedConnection.metadata,
    disabledChannels: ["newer-concurrent-channel-deny"],
  },
  editVersion: "4",
};

type DetailResponse =
  | { status: 200; connection: TestConnection }
  | { status: 503 };
type PatchResponse = { status: 200; editVersion: string } | { status: 409 };

function sanitizedBody(body: Record<string, unknown>): Record<string, unknown> {
  const record = { ...body };
  if ("botToken" in record) record.botToken = "[synthetic-token]";
  return record;
}

async function installDiscordScenario(
  page: Page,
  options: {
    details: DetailResponse[];
    patches: PatchResponse[];
  },
): Promise<{ requestLog: RequestRecord[] }> {
  const requestLog: RequestRecord[] = [];
  const details = [...options.details];
  const patches = [...options.patches];
  let currentConnection = baseConnection;

  await page.unroute("**/api/cloud/status");
  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        enabled: true,
        cloudVoiceProxyAvailable: true,
        hasApiKey: true,
        userId: "cloud-audit-smoke-user",
      }),
    });
  });

  await page.unroute("**/api/cloud/credits");
  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        balance: 100,
        low: false,
        critical: false,
        authRejected: false,
      }),
    });
  });

  await page.route("**/api/v1/dashboard", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agents: [
          { id: CHARACTER_ID, name: "Cloud Agent" },
          { id: CONCURRENT_CHARACTER_ID, name: "Concurrent Agent" },
        ],
      }),
    });
  });

  await page.route(
    "**/api/conversations/cloud-management-smoke-conversation/messages",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [] }),
      });
    },
  );

  await page.route("**/api/v1/discord/connections**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const detailPath = `/api/v1/discord/connections/${CONNECTION_ID}`;

    if (url.pathname === "/api/v1/discord/connections" && method === "GET") {
      requestLog.push({ method, path: url.pathname, status: 200 });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ connections: [currentConnection] }),
      });
      return;
    }

    if (url.pathname === detailPath && method === "GET") {
      const response = details.shift();
      if (!response) {
        throw new Error("Unexpected Discord detail request");
      }
      requestLog.push({ method, path: url.pathname, status: response.status });
      if (response.status === 503) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Synthetic exact-row outage" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ connection: response.connection }),
      });
      return;
    }

    if (url.pathname === detailPath && method === "PATCH") {
      const response = patches.shift();
      if (!response) {
        throw new Error("Unexpected Discord PATCH request");
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      requestLog.push({
        method,
        path: url.pathname,
        status: response.status,
        body: sanitizedBody(body),
      });
      if (response.status === 409) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Connection settings changed elsewhere",
            code: "CONFIGURATION_CONFLICT",
          }),
        });
        return;
      }

      currentConnection = {
        ...currentConnection,
        characterId:
          typeof body.characterId === "string"
            ? body.characterId
            : currentConnection.characterId,
        isActive:
          typeof body.isActive === "boolean"
            ? body.isActive
            : currentConnection.isActive,
        metadata:
          body.metadata && typeof body.metadata === "object"
            ? (body.metadata as TestConnection["metadata"])
            : currentConnection.metadata,
        editVersion: response.editVersion,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, connection: currentConnection }),
      });
      return;
    }

    await route.fallback();
  });

  return { requestLog };
}

async function bootEditor(
  page: Page,
  options: {
    details: DetailResponse[];
    patches: PatchResponse[];
  },
): Promise<{
  card: Locator;
  requestLog: RequestRecord[];
}> {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, {
    "eliza:first-run-complete": "1",
    "eliza:setup:step": "activate",
  });
  await seedStewardSession(page, { jwt: true });
  await page.addInitScript(() => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:discord-conflict-smoke",
        kind: "cloud",
        label: "Discord conflict smoke",
        apiBase: window.location.origin,
      }),
    );
  });
  await installDefaultAppRoutes(page);
  await installCloudApiStubs(page);
  const scenario = await installDiscordScenario(page, options);

  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Cloud Connectors$/);
  const card = page
    .locator('[data-slot="connection-card"]')
    .filter({ hasText: "Discord Gateway Bot" })
    .first();
  await expect(card).toBeVisible({ timeout: 45_000 });
  await card.getByTestId("discord-connection-summary").click();
  await expect(
    card.getByPlaceholder("Your Discord user snowflake"),
  ).toBeVisible();
  return { card, requestLog: scenario.requestLog };
}

async function captureIfRecording(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  if (process.env.E2E_RECORD !== "1") return;
  const screenshotPath = testInfo.outputPath(`${name}.jpg`);
  await page.screenshot({
    path: screenshotPath,
    type: "jpeg",
    quality: 90,
    fullPage: true,
  });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/jpeg",
  });
  await page.waitForTimeout(750);
}

async function attachNetworkContract(
  testInfo: TestInfo,
  requestLog: RequestRecord[],
): Promise<void> {
  if (process.env.E2E_RECORD !== "1") return;
  await testInfo.attach("discord-http-boundary.json", {
    body: JSON.stringify(requestLog, null, 2),
    contentType: "application/json",
  });
}

function patchBodies(requestLog: RequestRecord[]): Record<string, unknown>[] {
  return requestLog
    .filter((entry) => entry.method === "PATCH")
    .map((entry) => {
      if (!entry.body)
        throw new Error("PATCH boundary record is missing its body");
      return entry.body;
    });
}

async function expectConflictLayout(
  card: Locator,
  projectName: string,
): Promise<void> {
  const mobile = projectName === "mobile-chromium";
  const summary = card.getByTestId("discord-connection-summary");
  const conflictActions = card.getByTestId("discord-conflict-actions");
  const reload = conflictActions.getByRole("button", {
    name: "Reload latest and discard my draft",
  });
  const keep = conflictActions.getByRole("button", {
    name: "Keep my draft and overwrite latest",
  });

  await expect
    .poll(() =>
      summary.evaluate((element) => getComputedStyle(element).flexDirection),
    )
    .toBe(mobile ? "column" : "row");
  await expect
    .poll(() =>
      conflictActions.evaluate((element) => getComputedStyle(element).display),
    )
    .toBe(mobile ? "grid" : "flex");

  const [actionsBox, reloadBox, keepBox] = await Promise.all([
    conflictActions.boundingBox(),
    reload.boundingBox(),
    keep.boundingBox(),
  ]);
  if (!actionsBox || !reloadBox || !keepBox) {
    throw new Error("Discord conflict controls have no rendered geometry");
  }
  if (mobile) {
    expect(reloadBox.height).toBeGreaterThanOrEqual(44);
    expect(keepBox.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(reloadBox.width - actionsBox.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(keepBox.width - actionsBox.width)).toBeLessThanOrEqual(2);
    expect(keepBox.y).toBeGreaterThan(reloadBox.y);
  } else {
    expect(Math.abs(keepBox.y - reloadBox.y)).toBeLessThanOrEqual(2);
    expect(reloadBox.width).toBeLessThan(actionsBox.width);
    expect(keepBox.width).toBeLessThan(actionsBox.width);
  }

  const overflow = await card.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
}

async function expectEditorActionLayout(
  card: Locator,
  projectName: string,
): Promise<void> {
  const mobile = projectName === "mobile-chromium";
  const actions = card.getByTestId("discord-connection-actions");
  const disconnect = actions.getByRole("button", {
    name: "Delete Connection",
  });
  const save = actions.getByRole("button", { name: "Save Changes" });
  await expect
    .poll(() =>
      actions.evaluate((element) => getComputedStyle(element).flexDirection),
    )
    .toBe(mobile ? "column" : "row");

  const [disconnectBox, saveBox] = await Promise.all([
    disconnect.boundingBox(),
    save.boundingBox(),
  ]);
  if (!disconnectBox || !saveBox) {
    throw new Error("Discord editor actions have no rendered geometry");
  }
  if (mobile) {
    expect(disconnectBox.y).toBeLessThan(saveBox.y);
  } else {
    expect(Math.abs(disconnectBox.y - saveBox.y)).toBeLessThanOrEqual(2);
  }
}

test("409 keep-draft flow re-blocks on a repeated concurrent edit", async ({
  page,
}, testInfo) => {
  const { card, requestLog } = await bootEditor(page, {
    details: [
      { status: 200, connection: openedConnection },
      { status: 200, connection: conflictedConnection },
      { status: 200, connection: repeatedConflictConnection },
    ],
    patches: [{ status: 409 }, { status: 409 }],
  });
  const owner = card.getByPlaceholder("Your Discord user snowflake");
  const token = card.getByPlaceholder("Leave empty to keep current token");
  const save = card.getByRole("button", { name: "Save Changes" });
  await owner.fill("555555555555555");
  await token.fill(SYNTHETIC_TOKEN);
  await captureIfRecording(page, testInfo, "editor-before-conflict");

  await save.click();
  const conflictNotice = card.getByText(
    "Connection settings changed elsewhere",
    { exact: true },
  );
  await expect(conflictNotice).toBeVisible();
  await expect(save).toBeDisabled();
  await expectConflictLayout(card, testInfo.project.name);
  await conflictNotice.scrollIntoViewIfNeeded();
  await captureIfRecording(page, testInfo, "conflict-blocked");

  await card
    .getByRole("button", { name: "Keep my draft and overwrite latest" })
    .click();
  await expect(save).toBeEnabled();
  await expect(owner).toHaveValue("555555555555555");
  await expect(token).toHaveValue(SYNTHETIC_TOKEN);
  await expectEditorActionLayout(card, testInfo.project.name);
  await captureIfRecording(page, testInfo, "draft-kept");
  await save.click();

  await expect(
    card.getByText("Connection settings changed elsewhere", { exact: true }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(owner).toHaveValue("555555555555555");
  await expect(token).toHaveValue(SYNTHETIC_TOKEN);
  const patches = patchBodies(requestLog);
  expect(patches).toHaveLength(2);
  expect(patches[0]?.expectedEditVersion).toBe("2");
  expect(patches[1]?.expectedEditVersion).toBe("3");
  await expectOnlyAllowedPageDiagnostics(page, testInfo.title, [
    /^http\.409: PATCH .*\/api\/v1\/discord\/connections\//,
    /^console\.error: Failed to load resource: the server responded with a status of 409/,
  ]);
  await expectNoRenderTelemetryErrors(page, testInfo.title);
  await attachNetworkContract(testInfo, requestLog);
});

test("reload-latest discards the draft and omits the cleared token", async ({
  page,
}, testInfo) => {
  const { card, requestLog } = await bootEditor(page, {
    details: [
      { status: 200, connection: openedConnection },
      { status: 200, connection: conflictedConnection },
    ],
    patches: [{ status: 409 }, { status: 200, editVersion: "4" }],
  });
  const owner = card.getByPlaceholder("Your Discord user snowflake");
  const token = card.getByPlaceholder("Leave empty to keep current token");
  const save = card.getByRole("button", { name: "Save Changes" });
  await owner.fill("555555555555555");
  await token.fill(SYNTHETIC_TOKEN);
  await save.click();
  await card
    .getByRole("button", { name: "Reload latest and discard my draft" })
    .click();

  await expect(owner).toHaveValue("999999999999999");
  await expect(token).toHaveValue("");
  await expect(save).toBeEnabled();
  await captureIfRecording(page, testInfo, "latest-reloaded");
  await save.click();
  const patches = patchBodies(requestLog);
  expect(patches).toHaveLength(2);
  const secondPatch = patches[1];
  if (!secondPatch) {
    throw new Error("Expected the explicit reload to produce a second PATCH");
  }
  expect(secondPatch.expectedEditVersion).toBe("3");
  expect(secondPatch).not.toHaveProperty("botToken");
  expect(
    (secondPatch.metadata as Record<string, unknown>).disabledChannels,
  ).toEqual(["concurrent-channel-deny"]);
  await expectOnlyAllowedPageDiagnostics(page, testInfo.title, [
    /^http\.409: PATCH .*\/api\/v1\/discord\/connections\//,
    /^console\.error: Failed to load resource: the server responded with a status of 409/,
  ]);
  await expectNoRenderTelemetryErrors(page, testInfo.title);
  await attachNetworkContract(testInfo, requestLog);
});

test("an exact-row read failure hides stale controls until retry", async ({
  page,
}, testInfo) => {
  const { card, requestLog } = await bootEditor(page, {
    details: [
      { status: 200, connection: openedConnection },
      { status: 503 },
      { status: 200, connection: openedConnection },
    ],
    patches: [],
  });
  const summary = card.getByTestId("discord-connection-summary");
  const token = card.getByPlaceholder("Leave empty to keep current token");
  await token.fill(SYNTHETIC_TOKEN);
  await summary.click();
  await expect(token).toHaveCount(0);
  await summary.click();

  await expect(
    card.getByText("Connection settings are unavailable", { exact: true }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Save Changes" })).toHaveCount(
    0,
  );
  await expect(
    card.getByPlaceholder("Leave empty to keep current token"),
  ).toHaveCount(0);
  await captureIfRecording(page, testInfo, "exact-read-unavailable");

  await card.getByRole("button", { name: "Retry loading settings" }).click();
  const recoveredToken = card.getByPlaceholder(
    "Leave empty to keep current token",
  );
  await expect(recoveredToken).toHaveValue("");
  await expect(
    card.getByRole("button", { name: "Save Changes" }),
  ).toBeEnabled();
  expect(patchBodies(requestLog)).toHaveLength(0);
  await captureIfRecording(page, testInfo, "recovered-with-token-cleared");
  await expectOnlyAllowedPageDiagnostics(page, testInfo.title, [
    /^http\.503: GET .*\/api\/v1\/discord\/connections\//,
    /^console\.error: Failed to load resource: the server responded with a status of 503/,
  ]);
  await expectNoRenderTelemetryErrors(page, testInfo.title);
  await attachNetworkContract(testInfo, requestLog);
});
