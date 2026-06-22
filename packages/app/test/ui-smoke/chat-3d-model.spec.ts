// Inline 3D model LIVE render (#8876, #8988). A chat message carrying a
// `.glb` attachment must render an actual three.js WebGL preview — not just the
// download fallback. Headless Chromium provides software WebGL (SwiftShader), so
// we seed a real (small) .glb, serve its bytes, open /chat, and assert the
// viewer reaches the rendered state (the WebGL <canvas> is mounted), proving the
// lazy three.js + GLTFLoader path works end-to-end. Recordable via E2E_RECORD.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB_BYTES = readFileSync(path.join(HERE, "fixtures", "model.glb"));
const HASH = "c".repeat(64);
const CONVERSATION_ID = "model3d-conversation";
const ROOM_ID = "model3d-room";
const NOW = new Date().toISOString();
const NOW_MS = Date.now();

async function installSeededModelChat(page: Page): Promise<void> {
  const conversation = {
    id: CONVERSATION_ID,
    roomId: ROOM_ID,
    title: "3D model chat",
    updatedAt: NOW,
    createdAt: NOW,
  };
  const messages = [
    {
      id: "seed-user-1",
      role: "user" as const,
      text: "Generate a 3D model.",
      source: "eliza",
      roomId: ROOM_ID,
      timestamp: NOW_MS - 5_000,
    },
    {
      id: "seed-assistant-1",
      role: "assistant" as const,
      text: "Here's the 3D model.",
      source: "eliza",
      roomId: ROOM_ID,
      timestamp: NOW_MS - 2_000,
      attachments: [
        {
          id: "model-1",
          url: `/api/media/${HASH}.glb`,
          contentType: "document",
          title: "model.glb",
          mimeType: "model/gltf-binary",
        },
      ],
    },
  ];

  await page.route("**/api/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversations: [conversation] }),
      });
      return;
    }
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/conversations/${CONVERSATION_ID}`, async (route) => {
    if (
      route.request().method() === "PATCH" ||
      route.request().method() === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages**`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/greeting**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "Ready.", localInference: null }),
      });
    },
  );

  // Serve the real .glb bytes for the attachment URL the viewer fetches.
  await page.route(`**/api/media/${HASH}.glb`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "model/gltf-binary",
      body: GLB_BYTES,
    });
  });
}

test("chat: a .glb attachment renders an inline three.js WebGL viewer (not just a download)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installSeededModelChat(page);

  await openAppPath(page, "/chat");

  // The 3D tile renders for the .glb attachment.
  const tile = page.getByTestId("model3d-attachment").first();
  await expect(tile).toBeVisible({ timeout: 60_000 });

  // The live render succeeds: the lazy three.js path mounts a real WebGL
  // <canvas> inside the viewer container (only happens after GLTFLoader loads
  // the model + the renderer is created — i.e. NOT the download fallback).
  const canvas = page.locator('[data-testid="model3d-canvas"] canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // And it did NOT degrade to the download-only fallback.
  await expect(page.getByTestId("model3d-attachment-fallback")).toHaveCount(0);

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
