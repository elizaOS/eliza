/**
 * Browser integration coverage for the production voice-profile manager. The
 * real UI client and settings surface run against a stateful HTTP fixture so
 * every lifecycle mutation is proven at the transport boundary.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

interface ProfileFixture {
  id: string;
  entityId: string | null;
  displayName: string;
  relationshipLabel: string | null;
  isOwner: boolean;
  embeddingCount: number;
  firstHeardAtMs: number;
  lastHeardAtMs: number;
  cohort: "owner" | "family" | "guest" | "unknown";
  source: "first-run" | "auto-clustered" | "manual";
  retentionDays: number | null;
  samplePreviewUri: string | null;
  samples: Array<{ id: string; durationMs: number; recordedAt: string }>;
}

function profile(
  id: string,
  overrides: Partial<ProfileFixture> = {},
): ProfileFixture {
  return {
    id,
    entityId: null,
    displayName: id,
    relationshipLabel: null,
    isOwner: false,
    embeddingCount: 2,
    firstHeardAtMs: 1,
    lastHeardAtMs: 2,
    cohort: "unknown",
    source: "auto-clustered",
    retentionDays: 30,
    samplePreviewUri: null,
    samples: [
      {
        id: `${id}-a`,
        durationMs: 1000,
        recordedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: `${id}-b`,
        durationMs: 1600,
        recordedAt: "2026-08-02T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

async function installVoiceProfileRoutes(page: Page): Promise<void> {
  let profiles = [
    profile("owner", {
      entityId: "entity-owner",
      displayName: "Owner",
      isOwner: true,
      cohort: "owner",
      source: "first-run",
    }),
    profile("split-source", { displayName: "Needs split" }),
    profile("merge-source", { displayName: "Duplicate voice" }),
    profile("merge-target", {
      displayName: "Alex",
      entityId: "entity-alex",
      cohort: "family",
    }),
    profile("bind-source", {
      displayName: "Unknown visitor",
      samples: [],
      embeddingCount: 1,
    }),
  ];

  await page.route("**/api/voice/profiles**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "GET" && url.pathname === "/api/voice/profiles") {
      await route.fulfill({ status: 200, json: { profiles } });
      return;
    }

    const match = /^\/api\/voice\/profiles\/([^/]+)(?:\/(\w+))?$/.exec(
      url.pathname,
    );
    const id = match?.[1];
    const operation = match?.[2];
    if (!id) {
      await route.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const current = profiles.find((candidate) => candidate.id === id);
    if (!current) {
      await route.fulfill({ status: 404, json: { error: "not found" } });
      return;
    }

    if (method === "PATCH" && !operation) {
      const updated = { ...current, ...body } as ProfileFixture;
      profiles = profiles.map((candidate) =>
        candidate.id === id ? updated : candidate,
      );
      await route.fulfill({ status: 200, json: updated });
      return;
    }
    if (method === "POST" && operation === "split") {
      const selected = new Set(body?.utteranceIds as string[]);
      const original = {
        ...current,
        samples: current.samples.filter((sample) => !selected.has(sample.id)),
      };
      const split = profile("split-result", {
        displayName: "Needs split (new)",
        samples: current.samples.filter((sample) => selected.has(sample.id)),
        embeddingCount: selected.size,
      });
      profiles = [
        ...profiles.filter((candidate) => candidate.id !== id),
        original,
        split,
      ];
      await route.fulfill({ status: 200, json: { original, split } });
      return;
    }
    if (method === "POST" && operation === "merge") {
      const targetId = String(body?.intoId ?? "");
      const target = profiles.find((candidate) => candidate.id === targetId);
      if (!target) {
        await route.fulfill({ status: 404, json: { error: "not found" } });
        return;
      }
      const merged = {
        ...target,
        embeddingCount: target.embeddingCount + current.embeddingCount,
        samples: [...target.samples, ...current.samples],
      };
      profiles = [
        ...profiles.filter(
          (candidate) => candidate.id !== id && candidate.id !== targetId,
        ),
        merged,
      ];
      await route.fulfill({ status: 200, json: merged });
      return;
    }
    if (method === "POST" && operation === "bind") {
      const updated = {
        ...current,
        entityId: String(body?.entityId ?? ""),
      };
      profiles = profiles.map((candidate) =>
        candidate.id === id ? updated : candidate,
      );
      await route.fulfill({ status: 200, json: updated });
      return;
    }
    if (method === "POST" && operation === "unbind") {
      const updated = { ...current, entityId: null };
      profiles = profiles.map((candidate) =>
        candidate.id === id ? updated : candidate,
      );
      await route.fulfill({ status: 200, json: updated });
      return;
    }
    if (method === "DELETE" && !operation) {
      profiles = profiles.filter((candidate) => candidate.id !== id);
      await route.fulfill({ status: 200, json: { deleted: id } });
      return;
    }
    await route.fulfill({ status: 405, json: { error: "unsupported" } });
  });
}

async function openVoiceProfiles(page: Page): Promise<void> {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installVoiceProfileRoutes(page);
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Voice$/);
  await expect(page.getByTestId("voice-profile-section")).toBeVisible({
    timeout: 30_000,
  });
}

test("voice profile lifecycle mutations round-trip through the real client", async ({
  page,
}) => {
  await openVoiceProfiles(page);

  await page.getByTestId("voice-profile-name-bind-source").click();
  const rename = page.getByTestId("voice-profile-rename-input-bind-source");
  await rename.fill("Jamie");
  await rename.press("Enter");
  await expect(page.getByTestId("voice-profile-name-bind-source")).toHaveText(
    "Jamie",
  );

  await page.getByTestId("voice-profile-manage-split-source").click();
  await page
    .getByTestId("voice-profile-split-split-source-split-source-a")
    .click();
  await page.getByTestId("voice-profile-split-split-source").click();
  await expect(
    page.getByTestId("voice-profile-row-split-result"),
  ).toBeVisible();

  await page.getByTestId("voice-profile-manage-bind-source").click();
  await page
    .getByTestId("voice-profile-bind-entity-bind-source")
    .fill("entity-jamie");
  await page.getByTestId("voice-profile-bind-bind-source").click();
  await expect(page.getByText("Bound to entity-jamie")).toBeVisible();
  await page.getByTestId("voice-profile-unbind-bind-source").click();
  await expect(
    page.getByTestId("voice-profile-bind-entity-bind-source"),
  ).toBeVisible();

  await page.getByTestId("voice-profile-manage-merge-source").click();
  await page.getByTestId("voice-profile-merge-target-merge-source").click();
  await page.getByRole("option", { name: "Alex" }).click();
  await page.getByTestId("voice-profile-merge-merge-source").click();
  await expect(page.getByTestId("voice-profile-row-merge-source")).toHaveCount(
    0,
  );
  await expect(
    page.getByTestId("voice-profile-row-merge-target"),
  ).toBeVisible();

  await page.getByTestId("voice-profile-delete-bind-source").click();
  await expect(page.getByTestId("voice-profile-row-bind-source")).toHaveCount(
    0,
  );
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`voice profile lifecycle expanded ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await openVoiceProfiles(page);
    const screenshotDir = path.join(
      process.cwd(),
      "test-results",
      "voice-profile-lifecycle",
    );
    await mkdir(screenshotDir, { recursive: true });
    const manage = page.getByTestId("voice-profile-manage-split-source");
    await captureScreenshotWithQualityRetry(
      page,
      `voice profile resting ${viewport.name}`,
      {
        fullPage: true,
        path: path.join(screenshotDir, `resting-${viewport.name}.png`),
        attempts: 3,
      },
    );
    await manage.hover();
    await captureScreenshotWithQualityRetry(
      page,
      `voice profile manage hover ${viewport.name}`,
      {
        fullPage: true,
        path: path.join(screenshotDir, `manage-hover-${viewport.name}.png`),
        attempts: 3,
      },
    );
    await manage.click();
    await expect(
      page.getByTestId("voice-profile-lifecycle-split-source"),
    ).toBeVisible();

    await captureScreenshotWithQualityRetry(
      page,
      `voice profile lifecycle ${viewport.name}`,
      {
        fullPage: true,
        path: path.join(screenshotDir, `expanded-${viewport.name}.png`),
        attempts: 3,
      },
    );

    const bindInput = page.getByTestId(
      "voice-profile-bind-entity-split-source",
    );
    await bindInput.scrollIntoViewIfNeeded();
    await expect(bindInput).toBeInViewport();
    const composer = page.getByPlaceholder("Ask Eliza");
    const [bindBox, composerBox] = await Promise.all([
      bindInput.boundingBox(),
      composer.boundingBox(),
    ]);
    expect(bindBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    if (bindBox && composerBox) {
      expect(bindBox.y + bindBox.height).toBeLessThanOrEqual(composerBox.y);
    }
    await captureScreenshotWithQualityRetry(
      page,
      `voice profile lifecycle bottom ${viewport.name}`,
      {
        fullPage: true,
        path: path.join(screenshotDir, `expanded-bottom-${viewport.name}.png`),
        attempts: 3,
      },
    );
  });
}
