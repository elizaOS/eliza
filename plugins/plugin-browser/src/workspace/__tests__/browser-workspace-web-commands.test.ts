/**
 * Web backend command semantics: Enter after fill submits, fill reports what
 * the control holds, wait answers at once, diff screenshot reads the current
 * page, diff url stays confined, and file writes refuse a symlink leaf.
 * Pages are served through the workspace's own network routes.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserDomainAllowlistPolicy,
  registerBrowserDomainPolicy,
  unregisterBrowserDomainPolicy,
} from "../../browser-domain-policy.js";
import { isBrowserDispatchFailure } from "../../dispatch-types.js";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";
import { isBrowserWorkspaceError } from "../browser-workspace-errors.js";
import { writeBrowserWorkspaceFile } from "../browser-workspace-helpers.js";
import type { BrowserWorkspaceCommand } from "../browser-workspace-types.js";

const env: NodeJS.ProcessEnv = {};

function run(command: BrowserWorkspaceCommand) {
  return executeBrowserWorkspaceCommand(command, env);
}

async function route(
  id: string,
  url: string,
  responseBody: string,
  extra: Partial<BrowserWorkspaceCommand> = {},
): Promise<void> {
  await run({
    id,
    subaction: "network",
    networkAction: "route",
    url,
    responseBody,
    ...extra,
  });
}

async function openPage(url: string, html: string): Promise<string> {
  const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, env);
  await route(tab.id, url, html);
  await run({ id: tab.id, subaction: "navigate", url });
  return tab.id;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected the command to fail");
    },
    (error: unknown) => error,
  );
}

describe("web workspace commands", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("submits the form when Enter follows a fill", async () => {
    const id = await openPage(
      "https://shop.test/",
      `<form action="/search"><input name="q"><button>Search</button></form>`,
    );
    await route(id, "https://shop.test/search**", "<title>Results</title>");

    await run({ id, subaction: "fill", selector: "input", value: "socks" });
    const pressed = await run({ id, subaction: "press", key: "Enter" });

    expect(pressed.tab?.url).toBe("https://shop.test/search?q=socks");
  });

  it("says when a key had no effect", async () => {
    const id = await openPage("https://shop.test/", "<p>Nothing here</p>");
    const pressed = await run({ id, subaction: "press", key: "Enter" });
    expect(pressed.value).toMatchObject({ key: "Enter", effect: "none" });
  });

  it("fails a select fill whose option does not exist", async () => {
    const id = await openPage(
      "https://shop.test/",
      `<select name="size"><option value="s">S</option><option value="m">M</option></select>`,
    );

    const filled = await run({
      id,
      subaction: "fill",
      selector: "select",
      value: "m",
    });
    expect(filled.value).toMatchObject({ value: "m" });

    const error = await rejection(
      run({ id, subaction: "fill", selector: "select", value: "xl" }),
    );
    expect(String(error)).toContain('no option with value "xl"');
  });

  it("refuses to fill a read-only field", async () => {
    const id = await openPage(
      "https://shop.test/",
      `<input name="code" value="A1" readonly>`,
    );
    const error = await rejection(
      run({ id, subaction: "fill", selector: "input", value: "B2" }),
    );
    expect(String(error)).toContain("read-only");
  });

  it("fails a wait on an absent selector at once without holding other tabs", async () => {
    const waiting = await openPage("https://shop.test/a", "<p>A</p>");
    const other = await openPage(
      "https://shop.test/b",
      `<input type="checkbox" id="agree">`,
    );

    const startedAt = Date.now();
    const [wait, click] = await Promise.allSettled([
      run({
        id: waiting,
        subaction: "wait",
        selector: ".result",
        timeoutMs: 60_000,
      }),
      run({ id: other, subaction: "click", selector: "#agree" }),
    ]);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(wait.status).toBe("rejected");
    expect(String((wait as PromiseRejectedResult).reason)).toContain(
      "Wait condition not met",
    );
    expect(click.status).toBe("fulfilled");
  });

  it("detects a page change in diff screenshot", async () => {
    const id = await openPage(
      "https://shop.test/",
      `<input name="q" value="before">`,
    );
    await run({ id, subaction: "screenshot" });
    await run({ id, subaction: "fill", selector: "input", value: "after" });

    const diff = await run({ id, subaction: "diff", diffAction: "screenshot" });

    expect(diff.value).toMatchObject({ changed: true });
  });

  it("refuses a file: URL in diff url", async () => {
    const id = await openPage("https://shop.test/", "<p>Page</p>");
    const error = await rejection(
      run({
        id,
        subaction: "diff",
        diffAction: "url",
        url: "https://shop.test/",
        secondaryUrl: "file:///etc/hostname",
      }),
    );
    expect(isBrowserWorkspaceError(error)).toBe(true);
    expect(
      (error as { browserWorkspaceErrorCode?: string })
        .browserWorkspaceErrorCode,
    ).toBe("invalid_url");
  });

  describe("with a read allowlist", () => {
    const policyId = "web-commands-test-reads";

    beforeEach(() => {
      registerBrowserDomainPolicy(
        createBrowserDomainAllowlistPolicy({
          id: policyId,
          allowedDomains: ["shop.test"],
          gatedEffects: ["read"],
        }),
      );
    });

    afterEach(() => {
      unregisterBrowserDomainPolicy(policyId);
    });

    it("refuses a diff url redirect to a blocked host", async () => {
      const id = await openPage("https://shop.test/", "<p>Page</p>");
      await route(id, "https://shop.test/hop", "", {
        responseStatus: 302,
        responseHeaders: { Location: "https://blocked.test/secret" },
      });

      const error = await rejection(
        run({
          id,
          subaction: "diff",
          diffAction: "url",
          url: "https://shop.test/",
          secondaryUrl: "https://shop.test/hop",
        }),
      );

      expect(isBrowserDispatchFailure(error)).toBe(true);
      expect((error as { kind?: string }).kind).toBe("POLICY_BLOCKED");
      expect(String(error)).toContain("blocked.test");
    });
  });
});

describe("workspace file writes", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((dir) => fsp.rm(dir, { recursive: true, force: true })),
    );
  });

  it("refuses a dangling symlink at the leaf", async () => {
    const root = fs.realpathSync(
      await fsp.mkdtemp(path.join(os.tmpdir(), "bw-leaf-")),
    );
    const outside = fs.realpathSync(
      await fsp.mkdtemp(path.join(os.tmpdir(), "bw-outside-")),
    );
    roots.push(root, outside);
    const target = path.join(outside, "new.json");
    await fsp.symlink(target, path.join(root, "out.json"));

    const error = await rejection(
      writeBrowserWorkspaceFile(path.join(root, "out.json"), "{}", root),
    );

    expect(
      (error as { browserWorkspaceErrorCode?: string })
        .browserWorkspaceErrorCode,
    ).toBe("path_forbidden");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("still overwrites a regular file", async () => {
    const root = fs.realpathSync(
      await fsp.mkdtemp(path.join(os.tmpdir(), "bw-leaf-")),
    );
    roots.push(root);
    const file = path.join(root, "out.json");
    await fsp.writeFile(file, "old contents");

    await writeBrowserWorkspaceFile(file, "{}", root);

    expect(await fsp.readFile(file, "utf8")).toBe("{}");
  });
});
