/**
 * Exercises the real chat-to-personal-workspace handoff in the app shell with
 * deterministic transport fixtures. The test proves that a typed Shared-agent
 * capability failure becomes an inline setup card, preserves the exact user
 * intent, and dispatches only the server-authorized in-app destination.
 */

import { writeFile } from "node:fs/promises";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const NOW = "2026-01-01T00:00:00.000Z";
const CONVERSATION_ID = "capability-handoff-conversation";
const ROOM_ID = "capability-handoff-room";
const USER_INTENT = "Move tomorrow's meeting to 3pm";
const DESTINATION = "/cloud/agents/agent-1";
const STORAGE_KEY = "elizaos:capability-workspace-handoff";

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installCapabilityHandoffRoutes(
  page: Page,
): Promise<{ streamRequests: string[] }> {
  const streamRequests: string[] = [];
  const conversation = {
    id: CONVERSATION_ID,
    roomId: ROOM_ID,
    title: "Calendar handoff",
    updatedAt: NOW,
    createdAt: NOW,
  };

  await page.route("**/api/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      ...(route.request().method() === "GET"
        ? { conversations: [conversation] }
        : { conversation }),
    });
  });

  await page.route(`**/api/conversations/${CONVERSATION_ID}`, async (route) => {
    await fulfillJson(route, { conversation });
  });

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages**`,
    async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, { messages: [] });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages/stream`,
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const userText = body.text?.trim() ?? "";
      streamRequests.push(userText);
      const assistantText =
        "Calendar needs your personal workspace. I kept your request ready.";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: assistantText,
            fullText: assistantText,
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "done",
            fullText: assistantText,
            agentName: "Eliza",
            userMessageId: "capability-user-1",
            messageId: "capability-assistant-1",
            actionResults: [
              {
                actionName: "DEDICATED_CAPABILITY_REQUIRED",
                success: false,
                text: assistantText,
                values: {
                  capabilityHandoff: {
                    version: 1,
                    kind: "capability_handoff",
                    capabilityId: "calendar",
                    label: "Calendar",
                    availability: "needs_workspace",
                    reason: "Calendar needs your personal workspace.",
                    currentTier: "shared",
                    requiredTier: "personal",
                    nextAction: "upgrade_workspace",
                    requiresConfirmation: true,
                    cta: {
                      label: "Set up personal workspace",
                      href: DESTINATION,
                    },
                    continuation: {
                      originalIntent: userText,
                      clientMessageId: "capability-user-1",
                    },
                  },
                },
              },
            ],
          })}\n\n`,
      });
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/greeting**`,
    async (route) => {
      await fulfillJson(route, {
        text: "I can help plan today. Tell me what's fixed first.",
        localInference: null,
      });
    },
  );

  return { streamRequests };
}

async function openChatSheet(page: Page): Promise<void> {
  const sheet = page.getByTestId("chat-sheet");
  if ((await sheet.getAttribute("data-variant")) === "open") return;
  const grabber = page.getByTestId("chat-sheet-grabber");
  if ((await grabber.count()) === 0) return;
  await grabber.focus();
  await page.keyboard.press("ArrowUp");
  await expect(sheet).toHaveAttribute("data-variant", "open", {
    timeout: 5_000,
  });
}

test.use({ video: "on" });

test("Shared capability gate preserves intent and opens personal workspace setup", async ({
  page,
}, testInfo) => {
  const consoleEntries: string[] = [];
  const networkEntries: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) =>
    consoleEntries.push(`[${message.type()}] ${message.text()}`),
  );
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("request", (request) =>
    networkEntries.push(`${request.method()} ${request.url()}`),
  );

  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  const handles = await installCapabilityHandoffRoutes(page);
  await openAppPath(page, "/chat");

  if (process.env.ELIZA_MANUAL_ONBOARDING_REVIEW === "1") {
    console.log(
      `[manual-review] Drive the capability handoff in Chromium with: ${USER_INTENT}`,
    );
    console.log(
      "[manual-review] Press Ctrl+C when finished; run test:e2e:record for the asserted recording.",
    );
    await page.pause();
  }

  await page.getByTestId("chat-composer-textarea").fill(USER_INTENT);
  await page.getByTestId("chat-composer-action").click();
  await expect.poll(() => handles.streamRequests).toContain(USER_INTENT);
  await openChatSheet(page);

  const card = page.getByTestId("capability-workspace-setup");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Set up Calendar");
  await expect(card).toContainText("I kept your request ready.");
  await page.screenshot({
    path: testInfo.outputPath("capability-handoff-desktop.jpg"),
    fullPage: true,
    type: "jpeg",
    quality: 88,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("capability-handoff-mobile.jpg"),
    fullPage: true,
    type: "jpeg",
    quality: 88,
  });

  await page.evaluate(() => {
    (
      window as unknown as { __capabilityNavigations: string[] }
    ).__capabilityNavigations = [];
    window.addEventListener("eliza:navigate:view", (event) => {
      const detail = (event as CustomEvent<{ viewPath?: string }>).detail;
      if (typeof detail?.viewPath === "string") {
        (
          window as unknown as { __capabilityNavigations: string[] }
        ).__capabilityNavigations.push(detail.viewPath);
      }
    });
  });
  await card.getByRole("button", { name: "Set up personal workspace" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __capabilityNavigations?: string[] })
            .__capabilityNavigations ?? [],
      ),
    )
    .toContain(DESTINATION);
  const persisted = await page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);
  expect(persisted).toMatchObject({
    handoff: {
      capabilityId: "calendar",
      cta: { href: DESTINATION },
      continuation: { originalIntent: USER_INTENT },
    },
  });
  expect(pageErrors).toEqual([]);

  await writeFile(
    testInfo.outputPath("frontend-console.log"),
    consoleEntries.join("\n"),
  );
  await writeFile(
    testInfo.outputPath("frontend-network.log"),
    networkEntries.join("\n"),
  );
  await testInfo.attach("frontend-console", {
    body: Buffer.from(consoleEntries.join("\n")),
    contentType: "text/plain",
  });
  await testInfo.attach("frontend-network", {
    body: Buffer.from(networkEntries.join("\n")),
    contentType: "text/plain",
  });
});
