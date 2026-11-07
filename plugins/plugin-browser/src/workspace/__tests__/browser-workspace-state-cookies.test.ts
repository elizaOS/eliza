/**
 * Loading a saved web workspace state replaces the cookie jar. A cookie set
 * after the save used to remain, so the restored page still presented it.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";
import {
  applyBrowserWorkspaceStateToWebDocument,
  readBrowserWorkspaceCookies,
} from "../browser-workspace-snapshots.js";

const webEnv: NodeJS.ProcessEnv = {};
const files: string[] = [];

afterEach(async () => {
  await __resetBrowserWorkspaceStateForTests();
  await Promise.all(
    files.splice(0).map((file) => fsp.rm(file, { force: true })),
  );
});

it("drops cookies that were not in the saved workspace state", async () => {
  const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
  const url = "https://example.test/cookies";
  await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "network",
      networkAction: "route",
      url,
      responseBody: "<!doctype html><title>Cookies</title>",
    },
    webEnv,
  );
  await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "navigate", url },
    webEnv,
  );
  await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "cookies",
      cookieAction: "set",
      name: "session",
      value: "saved",
    },
    webEnv,
  );
  const filePath = path.join(
    process.cwd(),
    `.bw-state-cookies-${os.pid}-${Date.now()}.json`,
  );
  files.push(filePath);
  await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "state", filePath },
    webEnv,
  );
  await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "cookies",
      cookieAction: "set",
      name: "leak",
      value: "after-save",
    },
    webEnv,
  );
  await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "cookies",
      cookieAction: "set",
      name: "session",
      value: "mutated",
    },
    webEnv,
  );
  await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "state", stateAction: "load", filePath },
    webEnv,
  );
  const cookies = await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "cookies", cookieAction: "get" },
    webEnv,
  );
  expect(cookies.value).toEqual({ session: "saved" });
});

it("drops a cookie the page set from a sub-path", () => {
  const { document } = new JSDOM("<!doctype html><title>Sub</title>", {
    url: "https://example.test/app/workspace/page",
  }).window;
  document.cookie = "session=saved; path=/";
  // No Path attribute: the default path is /app/workspace, not /.
  document.cookie = "leak=after-save";
  document.cookie = "deep=after-save; path=/app/workspace/page";
  document.cookie = "session=mutated; path=/";

  applyBrowserWorkspaceStateToWebDocument(document, {
    cookies: { session: "saved" },
  });

  expect(readBrowserWorkspaceCookies(document)).toEqual({ session: "saved" });
});

it("leaves the cookie jar alone when the saved cookies are not a record", () => {
  const { document } = new JSDOM("<!doctype html><title>Array</title>", {
    url: "https://example.test/",
  }).window;
  document.cookie = "session=current; path=/";

  applyBrowserWorkspaceStateToWebDocument(document, {
    cookies: [{ name: "session", value: "saved" }],
  });

  expect(readBrowserWorkspaceCookies(document)).toEqual({ session: "current" });
});
