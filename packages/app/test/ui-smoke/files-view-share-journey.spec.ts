// Files view SHARE journey (#8876). "Sharing" is named first in the goal
// (preview, display, sharing, downloading). The Files surface exposes a Share
// control per file that routes through the transport-aware `shareAttachment`
// helper → the Web Share API (`navigator.share({ url, title })`). Headless
// Chromium has no Web Share API, so we inject a recording stub BEFORE load (this
// also makes `canShareFiles()` true so the Share control renders), open the
// Files view, click Share, and assert the share sheet was invoked with the
// file's served URL + title. Recordable via E2E_RECORD.
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

test("files view: share a file (Web Share API invoked with the served url + title)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // Inject a recording Web Share API stub BEFORE any app code runs. This both
  // (a) makes canShareFiles() true so the Share control renders, and (b) lets us
  // assert what the app handed to the share sheet — without a real OS share.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __shareCalls?: Array<Record<string, unknown>>;
    };
    w.__shareCalls = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: Record<string, unknown>) => {
        w.__shareCalls?.push(data);
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
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

  // The Share control is present (the injected Web Share API made it supported).
  const shareBtn = page.getByTestId("file-share").first();
  await expect(shareBtn).toBeVisible();
  await shareBtn.click();

  // The Web Share API was invoked with the file's served URL + its title.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __shareCalls?: unknown[] }).__shareCalls
              ?.length ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  const shareData = await page.evaluate(
    () =>
      (
        window as unknown as {
          __shareCalls?: Array<{ url?: string; title?: string }>;
        }
      ).__shareCalls?.[0],
  );
  expect(shareData?.url, "share url points at the served media").toContain(
    `/api/media/${HASH_A}.png`,
  );
  expect(shareData?.title).toBe(`${HASH_A}.png`);

  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
