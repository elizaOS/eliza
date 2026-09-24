/** Exercises root import, explicit client installation and signed-page registration against the real UI collaborators. */

import {
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
} from "@elizaos/ui";
import { ElizaClient } from "@elizaos/ui/api";
import { expect, it } from "vitest";

it("keeps root imports passive and installs the Calendar surface explicitly", async () => {
  const initial = getAppShellPageRegistrySnapshot();
  const before = ElizaClient.prototype.getLifeOpsCalendarFeed;
  const { registerCalendarApp, installCalendarClient, CalendarPage } =
    await import("./index.js");
  expect(getAppShellPageRegistrySnapshot()).toBe(initial);
  expect(ElizaClient.prototype.getLifeOpsCalendarFeed).toBe(before);
  installCalendarClient();
  const installed = ElizaClient.prototype.getLifeOpsCalendarFeed;
  expect(installed).toBeTypeOf("function");
  installCalendarClient();
  expect(ElizaClient.prototype.getLifeOpsCalendarFeed).toBe(installed);
  registerCalendarApp();
  const page = listAppShellPages().find((entry) => entry.id === "calendar");
  if (!page?.loader) throw new Error("Calendar has no signed page loader");
  expect(appShellPageMatchesPath(page, "/calendar")).toBe(true);
  expect(appShellPageMatchesPath(page, "/calendar-other")).toBe(false);
  expect((await page.loader()).default).toBe(CalendarPage);
  const registered = getAppShellPageRegistrySnapshot();
  registerCalendarApp();
  expect(getAppShellPageRegistrySnapshot()).toBe(registered);
});
