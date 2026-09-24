/**
 * Browser E2E for the developer context-inspector page. The renderer and app
 * shell are real; the focused DTO fixture proves the view never asks for raw
 * trajectory data and renders access revocation as a visible error.
 */

import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const RAW_CANARY = "TOP SECRET E2E BODY";
const RAW_PATH = "/Users/private/mail/account-77/message-99";

test("context inspector renders redacted metadata and fails visibly after access revocation", async ({
  page,
}, testInfo) => {
  const consoleErrors: Array<{ text: string; url: string }> = [];
  const inspectorRequests: string[] = [];
  const inspectorResponses: string[] = [];
  let denied = false;

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({
        text: message.text(),
        url: message.location().url,
      });
    }
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/context-inspector") {
      inspectorRequests.push(request.url());
    }
  });
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/context-inspector") {
      inspectorResponses.push(await response.text());
    }
  });

  await seedAppStorage(page, { "eliza:developerMode": "1" });
  await installDefaultAppRoutes(page);
  await page.route("**/api/context-inspector?**", async (route) => {
    if (denied) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Context inspector access denied" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({
        schemaVersion: "elizaos.context-inspector/v1",
        entries: [
          {
            reference: "ctx_e2e0123456789abcdef",
            kind: "document",
            range: { unit: "fragment", start: 8, end: 9, total: 20 },
            completeness: "partial-recoverable",
            omissionReason: "token-budget",
            retentionState: "expired",
          },
        ],
        tokenBudgets: [
          {
            usedTokens: 640,
            limitTokens: 1000,
            reservedTokens: 120,
            state: "within-budget",
          },
        ],
        page: {
          offset: 0,
          limit: 20,
          hasPrevious: false,
          hasMore: false,
          nextOffset: null,
        },
        state: "available",
      }),
    });
  });

  await openAppPath(page, "/apps/context-inspector");
  const view = page.getByTestId("context-inspector-view");
  await expect(view).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("ctx_e2e0123456789abcdef")).toBeVisible();
  await expect(page.getByText("fragment 8–9 of 20")).toBeVisible();
  await expect(page.getByText("partial-recoverable")).toBeVisible();
  await expect(page.getByText("expired")).toBeVisible();
  await expect(page.getByTestId("context-inspector-budget")).toContainText(
    "640",
  );

  const html = await view.innerText();
  expect(html).not.toContain(RAW_CANARY);
  expect(html).not.toContain(RAW_PATH);
  expect(inspectorRequests).toHaveLength(1);
  const activeConversationId = await page.evaluate(() =>
    localStorage.getItem("eliza:chat:activeConversationId"),
  );
  expect(activeConversationId).toBeTruthy();
  expect(
    new URL(inspectorRequests[0] ?? "").searchParams.get("conversationId"),
  ).toBe(activeConversationId);
  expect(inspectorResponses.join("\n")).not.toContain(RAW_CANARY);
  expect(inspectorResponses.join("\n")).not.toContain(RAW_PATH);
  expect(consoleErrors).toEqual([]);

  if (process.env.E2E_RECORD === "1") {
    await page.screenshot({
      path: testInfo.outputPath("context-inspector-desktop.png"),
      fullPage: true,
    });
  }

  denied = true;
  await page.getByTestId("context-inspector-refresh").click();
  await expect(page.getByRole("alert")).toContainText(
    "Context state unavailable",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Context inspector access denied",
  );
  expect(consoleErrors).toEqual([
    {
      text: "Failed to load resource: the server responded with a status of 403 (Forbidden)",
      url: expect.stringContaining("/api/context-inspector"),
    },
  ]);
});
