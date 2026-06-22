// Files view CRUD journey (#8876). The "Files" surface lists stored files and
// supports delete (confirm → DELETE /api/files/:filename → optimistic removal)
// and download. This drives the real delete journey end-to-end: open the Files
// view, delete a file (confirming), and assert the DELETE request fired for the
// right file and the card was removed. Recordable via E2E_RECORD.
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const FILES_FIXTURE = {
  files: [
    {
      fileName: `${HASH_A}.png`,
      url: `/api/media/${HASH_A}.png`,
      hash: HASH_A,
      mimeType: "image/png",
      size: 20_480,
      createdAt: 1_700_000_002_000,
    },
    {
      fileName: `${HASH_B}.pdf`,
      url: `/api/media/${HASH_B}.pdf`,
      hash: HASH_B,
      mimeType: "application/pdf",
      size: 51_200,
      createdAt: 1_700_000_001_000,
    },
  ],
};

test("files view: delete a file (confirm → DELETE request → optimistic removal)", async ({
  page,
}) => {
  const deleted: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // Auto-confirm the delete confirmation dialog.
  await page.addInitScript(() => {
    window.confirm = () => true;
  });

  await seedAppStorage(page);
  await installDefaultAppRoutes(page);

  await page.route("**/api/files", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FILES_FIXTURE),
    }),
  );
  await page.route("**/api/files/*", async (route) => {
    if (route.request().method() === "DELETE") {
      const name = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").pop() ?? "",
      );
      deleted.push(name);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted: true }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/media/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(TINY_PNG_BASE64, "base64"),
    }),
  );

  await openAppPath(page, "/apps/files");

  // Both stored files render as cards.
  const cards = page.getByTestId("file-card");
  await expect(cards).toHaveCount(2, { timeout: 60_000 });

  // Delete the first file: click its delete control (confirm auto-accepts).
  await page.getByTestId("file-delete").first().click();

  // The DELETE request fired for that file, and the card was optimistically
  // removed (2 → 1).
  await expect
    .poll(() => deleted.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(deleted[0]).toBe(`${HASH_A}.png`);
  await expect(cards).toHaveCount(1, { timeout: 15_000 });

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
