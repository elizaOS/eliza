/** Exercises explicit Notes registration and lazy page loading against the real shell registry. */

import {
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
} from "@elizaos/ui";
import { expect, it } from "vitest";

it("registers the signed Notes page once without registering on root import", async () => {
  const initial = getAppShellPageRegistrySnapshot();
  const { registerNotesApp } = await import("./index.js");
  expect(getAppShellPageRegistrySnapshot()).toBe(initial);
  registerNotesApp();
  const page = listAppShellPages().find((entry) => entry.id === "notes");
  if (!page?.loader) throw new Error("Notes has no signed page loader");
  expect(appShellPageMatchesPath(page, "/notes")).toBe(true);
  expect(appShellPageMatchesPath(page, "/notes-other")).toBe(false);
  expect(typeof (await page.loader()).default).toBe("function");
  const registered = getAppShellPageRegistrySnapshot();
  registerNotesApp();
  expect(getAppShellPageRegistrySnapshot()).toBe(registered);
});
