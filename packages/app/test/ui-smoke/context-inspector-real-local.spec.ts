/**
 * Browser E2E for the context inspector against the supported real-local stack.
 * The host persists seeded trajectories in filesystem-backed PGlite; no route
 * interception or response fixture substitutes the API, auth, or renderer.
 */

import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const REAL_LOCAL_STACK = process.env.ELIZA_UI_SMOKE_REAL_LOCAL_STACK === "1";
const CONTEXT_INSPECTOR_E2E =
  process.env.ELIZA_UI_SMOKE_CONTEXT_INSPECTOR === "1";
const RAW_BODY = "TOP SECRET E2E BODY";
const RAW_PATH = "/private/e2e/account-";

test.describe("real-local context inspector", () => {
  test.skip(
    !REAL_LOCAL_STACK || !CONTEXT_INSPECTOR_E2E,
    "requires the gated real-local context inspector evidence stack",
  );
  test.setTimeout(180_000);

  test("reauthorizes, pages, redacts, and renders real PGlite trajectories", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    const inspectorWire: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname === "/api/context-inspector") {
        inspectorWire.push(await response.text());
      }
    });

    const conversationResponse = await page.request.post("/api/conversations", {
      data: {
        title: "Context inspector real-local evidence",
        metadata: { scope: "general" },
      },
    });
    expect(conversationResponse.ok()).toBe(true);
    const conversation = (await conversationResponse.json()) as {
      conversation?: { id?: string };
    };
    const conversationId = conversation.conversation?.id;
    expect(conversationId).toBeTruthy();

    const seedResponse = await page.request.post(
      "/api/device-e2e/context-inspector/seed",
      { data: { conversationId, count: 21 } },
    );
    expect(seedResponse.status()).toBe(200);
    expect(await seedResponse.json()).toEqual({ count: 21, conversationId });

    const first = await page.request.get(
      `/api/context-inspector?conversationId=${conversationId}&offset=0&limit=1`,
    );
    expect(first.status()).toBe(200);
    expect(first.headers()["cache-control"]).toBe("no-store");
    const firstBody = await first.text();
    expect(firstBody).not.toContain(RAW_BODY);
    expect(firstBody).not.toContain(RAW_PATH);
    const firstPage = JSON.parse(firstBody) as {
      entries: Array<{ reference: string }>;
      page: { hasMore: boolean; nextOffset: number | null };
    };
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]?.reference).toMatch(/^ctx_[a-f0-9]{20}$/);
    expect(firstPage.page).toMatchObject({ hasMore: true, nextOffset: 1 });

    const second = await page.request.get(
      `/api/context-inspector?conversationId=${conversationId}&offset=1&limit=1`,
    );
    expect(second.status()).toBe(200);
    const secondBody = await second.text();
    expect(secondBody).not.toContain(RAW_BODY);
    expect(secondBody).not.toContain(RAW_PATH);
    const secondPage = JSON.parse(secondBody) as {
      entries: Array<{ reference: string }>;
      page: { hasPrevious: boolean };
    };
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.page.hasPrevious).toBe(true);
    expect(secondPage.entries[0]?.reference).not.toBe(
      firstPage.entries[0]?.reference,
    );

    const invalid = await page.request.get(
      `/api/context-inspector?conversationId=${conversationId}&offset=-1`,
    );
    expect(invalid.status()).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Invalid context inspector request",
    });

    await seedAppStorage(page, {
      "eliza:chat:activeConversationId": conversationId ?? "",
      "eliza:developerMode": "true",
    });
    await openAppPath(page, "/apps/context-inspector");
    const view = page.getByTestId("context-inspector-view");
    await expect(view).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("context-inspector-entry")).toHaveCount(20);
    await expect(
      page.getByTestId("context-inspector-reference").first(),
    ).toHaveText(/^ctx_[a-f0-9]{20}$/);
    await expect(page.getByText("expired").first()).toBeVisible();
    await expect(page.getByTestId("context-inspector-budget")).toContainText(
      "Requests",
    );
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByTestId("context-inspector-entry")).toHaveCount(1);
    await expect(page.getByText("Trajectory window 21–40")).toBeVisible();

    const visibleText = await view.innerText();
    expect(visibleText).not.toContain(RAW_BODY);
    expect(visibleText).not.toContain(RAW_PATH);
    expect(inspectorWire.join("\n")).not.toContain(RAW_BODY);
    expect(inspectorWire.join("\n")).not.toContain(RAW_PATH);
    expect(consoleErrors).toEqual([]);

    const screenshotPath = testInfo.outputPath(
      "context-inspector-real-local-desktop.png",
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await writeFile(
      testInfo.outputPath("context-inspector-wire.json"),
      JSON.stringify(
        {
          conversationId,
          inspectorResponses: inspectorWire.map((body) => JSON.parse(body)),
        },
        null,
        2,
      ),
    );
  });
});
