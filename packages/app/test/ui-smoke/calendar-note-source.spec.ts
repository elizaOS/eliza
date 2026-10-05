/** Exercises source-note navigation in the real renderer with explicit synthetic HTTP fixtures, preserving historical links and showing missing sources. */
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureFamilyState } from "./helpers/family-review-capture";
import { seedStewardSession } from "./helpers/test-auth";
import { test } from "./helpers/viewport-video";

test.use({ video: "on", trace: "on" });
for (const width of [1280, 390]) {
  test.describe(`calendar source note ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("opens the exact historical source and explains a missing note", async ({
      page,
    }, info) => {
      await seedAppStorage(page, { "eliza:ui-accent": "orange" });
      await seedStewardSession(page, { jwt: true });
      await installDefaultAppRoutes(page);
      const errors: string[] = [];
      const writes: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          (request.url().includes("/api/lifeops/calendar/") ||
            request.url().includes("/api/notes/") ||
            request.url().includes("/api/views/notes/interact")) &&
          request.method() !== "GET"
        )
          writes.push(request.method());
      });
      await page.route("**/api/lifeops/calendar/calendars**", async (route) => {
        await route.fulfill({
          json: {
            calendars: [
              {
                provider: "eliza",
                side: "owner",
                grantId: "eliza-calendar",
                calendarId: "primary",
                connectorAccountId: null,
                accountEmail: null,
                summary: "Eliza Calendar",
                description: null,
                primary: true,
                accessRole: "owner",
                backgroundColor: null,
                foregroundColor: null,
                timeZone: "America/New_York",
                selected: true,
                includeInFeed: true,
              },
            ],
          },
        });
      });
      const sourceNote = {
        agentId: "smoke-agent",
        noteId: "source-library-note",
        contentHash: createHash("sha256")
          .update(
            JSON.stringify([
              "smoke-agent",
              "source-library-note",
              "Library pickup",
              "Collect reserved books.",
            ]),
          )
          .digest("hex"),
      };
      let sourceExists = true;
      await page.route("**/api/notes/state", async (route) => {
        await route.fulfill({
          json: {
            success: true,
            data: {
              revision: sourceExists ? 4 : 5,
              notes: sourceExists
                ? [
                    {
                      id: sourceNote.noteId,
                      title: "Library pickup",
                      body: "Collect reserved books. Bring the updated library card.",
                      color: "yellow",
                      createdAt: "2026-09-20T12:00:00.000Z",
                      updatedAt: "2026-09-21T12:00:00.000Z",
                    },
                  ]
                : [],
            },
          },
        });
      });
      await page.route("**/api/lifeops/calendar/feed**", async (route) => {
        const url = new URL(route.request().url());
        const start = new Date();
        start.setHours(16, 0, 0, 0);
        const event = {
          id: "synthetic-local-edit",
          externalId: "synthetic-local-edit",
          agentId: "smoke-agent",
          provider: "eliza",
          side: "owner",
          grantId: "eliza-calendar",
          calendarId: "primary",
          title: "Synthetic library pickup",
          description: "",
          location: "",
          status: "confirmed",
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 1800000).toISOString(),
          isAllDay: false,
          timezone: null,
          htmlLink: null,
          conferenceLink: null,
          organizer: null,
          attendees: [],
          metadata: {
            etag: '"eliza-2"',
            version: 2,
            sourceNote,
          },
          syncedAt: start.toISOString(),
          updatedAt: start.toISOString(),
          calendarSummary: "Eliza Calendar",
        };
        await route.fulfill({
          json: {
            events: [event],
            source: "cache",
            state: "complete",
            sources: [],
            timeMin: url.searchParams.get("timeMin"),
            timeMax: url.searchParams.get("timeMax"),
            syncedAt: start.toISOString(),
          },
        });
      });
      await openAppPath(page, "/calendar");
      await page.getByText("Synthetic library pickup", { exact: true }).click();
      const source = page.getByRole("button", {
        name: "Open source note",
        exact: true,
      });
      await expect(source).toBeVisible();
      await source.scrollIntoViewIfNeeded();
      const box = await source.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      await page.mouse.move(0, 0);
      await captureFamilyState(page, info, `source-link-rest-${width}`);
      await source.hover();
      await captureFamilyState(page, info, `source-link-hover-${width}`);
      const save = page.getByRole("button", {
        name: "Save event",
        exact: true,
      });
      await save.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          save.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            );
            return (
              bounds.top >= 0 &&
              bounds.bottom <= window.innerHeight &&
              hit !== null &&
              button.contains(hit)
            );
          }),
        )
        .toBe(true);
      await captureFamilyState(page, info, `source-link-footer-${width}`);
      await source.scrollIntoViewIfNeeded();
      await source.click();
      const selected = page.locator('[data-source-note="true"]');
      await expect(selected).toHaveCount(1);
      await expect(selected).toContainText("Bring the updated library card.");
      await expect(selected).toBeFocused();
      await expect(selected).toHaveCSS("border-left-width", "4px");
      await expect(selected).toHaveCSS("border-left-style", "solid");
      await expect(selected).toHaveCSS(
        "border-left-color",
        "rgb(255, 106, 31)",
      );
      await captureFamilyState(page, info, `source-note-open-${width}`);
      sourceExists = false;
      await openAppPath(page, "/calendar");
      await page.getByText("Synthetic library pickup", { exact: true }).click();
      await source.click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "The source note is no longer available." }),
      ).toBeVisible();
      await expect(selected).toHaveCount(0);
      await captureFamilyState(page, info, `source-note-missing-${width}`);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
