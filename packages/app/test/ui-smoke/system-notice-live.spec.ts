/** Real renderer consumes a live WebSocket failure update without a history reload. */
import { mkdir } from "node:fs/promises";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

for (const viewport of ["desktop", "mobile"] as const) {
  test(`preserves a live model-setup notice on ${viewport}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      viewport === "desktop"
        ? { width: 1440, height: 900 }
        : { width: 390, height: 844 },
    );
    await installDefaultAppRoutes(page);
    const conversationId = "live-notice-conversation";
    const conversation = {
      id: conversationId,
      title: "Live notice",
      roomId: "live-notice-room",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await page.route(/\/api\/conversations(?:\?.*)?$/, (route) =>
      route.fulfill({
        json:
          route.request().method() === "POST"
            ? { conversation }
            : { conversations: [conversation] },
      }),
    );
    await page.route(
      `**/api/conversations/${conversationId}/messages**`,
      (route) => route.fulfill({ json: { messages: [] } }),
    );
    await page.route(
      `**/api/conversations/${conversationId}/greeting`,
      (route) => route.fulfill({ json: { text: "" } }),
    );
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(
      (url) => url.pathname === "/ws",
      (socket) => {
        sockets.push(socket);
      },
    );
    await openAppPath(page, "/chat");
    await expect
      .poll(() =>
        page.evaluate(() =>
          localStorage.getItem("eliza:chat:activeConversationId"),
        ),
      )
      .toBe(conversationId);
    await expect.poll(() => sockets.length).toBeGreaterThan(0);
    const composer = page.getByLabel("message", { exact: true });
    await composer.focus();
    const message = {
      id: "live-system-notice",
      role: "assistant",
      text: "Configure a model provider on the connected host.",
      timestamp: Date.now(),
      source: "client_chat",
    };
    for (const socket of sockets)
      socket.send(
        JSON.stringify({ type: "proactive-message", conversationId, message }),
      );
    await expect(page.getByText(message.text, { exact: true })).toBeVisible();
    // Same id/text/time: classification alone must update the existing turn.
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          type: "proactive-message",
          conversationId,
          message: { ...message, failureKind: "no_provider" },
        }),
      );
    await expect(page.getByTestId("chat-no-provider-settings")).toBeVisible();
    await expect(page.locator('[data-failure="no_provider"]')).toContainText(
      message.text,
    );
    await page.getByTestId("chat-sheet-grabber").press("ArrowUp");
    await expect(
      page.getByText("Connect a provider to chat", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("chat-no-provider-settings")).toBeInViewport({
      ratio: 1,
    });
    const directory = testOutputPath(
      "nubscarson-review",
      "live-notice",
      viewport,
    );
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/provider-setup-notice.png` });
  });
}
