/** Exercises explicit Knowledge registration against the real shell registry and page loader. */

import {
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
} from "@elizaos/ui";
import { expect, it } from "vitest";

it("registers Knowledge only when requested and preserves both document routes", async () => {
  const initial = getAppShellPageRegistrySnapshot();
  const { registerKnowledgeApp, KnowledgeView } = await import("./index.js");
  expect(getAppShellPageRegistrySnapshot()).toBe(initial);
  registerKnowledgeApp();
  const page = listAppShellPages().find((entry) => entry.id === "documents");
  if (!page?.loader) throw new Error("Knowledge has no signed page loader");
  expect(appShellPageMatchesPath(page, "/documents")).toBe(true);
  expect(appShellPageMatchesPath(page, "/character/documents")).toBe(true);
  expect(appShellPageMatchesPath(page, "/character/other")).toBe(false);
  expect((await page.loader()).default).toBe(KnowledgeView);
  const registered = getAppShellPageRegistrySnapshot();
  registerKnowledgeApp();
  expect(getAppShellPageRegistrySnapshot()).toBe(registered);
});
