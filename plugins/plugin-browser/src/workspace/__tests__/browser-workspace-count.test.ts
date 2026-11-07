/** Count commands use the same complete match set in web and desktop pages. */
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";
import { createDesktopBrowserWorkspaceCommandScript } from "../browser-workspace-desktop.js";

const html = `<button data-testid="buy">Buy</button><button data-testid="buy">Buy</button>
<button>Buy later</button><button>Cancel</button>
<label for="email">Email</label><label for="email">Email</label><input id="email" />`;
afterEach(() => __resetBrowserWorkspaceStateForTests());

it.each([
  ["text:Buy", false, 3],
  ["text:Buy", true, 2],
  ["role:button", false, 4],
  ['role:button[name="Buy"]', true, 2],
  ["testid:buy", false, 2],
  ["label:Email", false, 1],
  ["css:button", false, 4],
  ["button", false, 4],
  ["text:missing", false, 0],
])(
  "counts %s (exact=%s) across both backends",
  async (selector, exact, count) => {
    const command = {
      subaction: "get" as const,
      getMode: "count" as const,
      selector,
      exact,
    };
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    try {
      expect(
        dom.window.eval(createDesktopBrowserWorkspaceCommandScript(command)),
      ).toEqual({ value: count });
    } finally {
      dom.window.close();
    }
    const env = {};
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, env);
    const url = "https://example.test/count";
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url,
        responseBody: html,
      },
      env,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url },
      env,
    );
    expect(
      (await executeBrowserWorkspaceCommand({ ...command, id: tab.id }, env))
        .value,
    ).toBe(count);
  },
);

const wrapped = `<section data-testid="hero"><h1>Shop</h1><a id="details" href="/details">View Details</a></section>`;

it("targets the link inside a matching wrapper in both backends", async () => {
  const dom = new JSDOM(wrapped, { runScripts: "outside-only" });
  try {
    expect(
      dom.window.eval(
        createDesktopBrowserWorkspaceCommandScript({
          subaction: "get",
          getMode: "count",
          selector: "text:View Details",
        }),
      ),
    ).toEqual({ value: 1 });
  } finally {
    dom.window.close();
  }
  const env = {};
  const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, env);
  for (const [url, responseBody] of [
    ["https://example.test/shop", wrapped],
    ["https://example.test/details", "<title>Details</title>"],
  ]) {
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url,
        responseBody,
      },
      env,
    );
  }
  await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "navigate", url: "https://example.test/shop" },
    env,
  );
  const clicked = await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "click", text: "View Details" },
    env,
  );
  expect(clicked.tab?.url).toBe("https://example.test/details");
});

const login = `<form>
<input id="user" name="user" value="octocat" />
<input id="pw" name="password" type="password" value="vault-secret-pw" />
<input id="csrf" name="csrf" type="hidden" value="csrf-token-123" />
</form>`;

it("never copies password or hidden input values out of the page in either backend", async () => {
  const dom = new JSDOM(login, { runScripts: "outside-only" });
  try {
    const snapshot = dom.window.eval(
      createDesktopBrowserWorkspaceCommandScript({ subaction: "snapshot" }),
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain("octocat");
    expect(serialized).not.toContain("vault-secret-pw");
    expect(serialized).not.toContain("csrf-token-123");
    expect(
      dom.window.eval(
        createDesktopBrowserWorkspaceCommandScript({
          subaction: "get",
          getMode: "value",
          selector: "#pw",
        }),
      ),
    ).toEqual({ value: null });
    for (const selector of ["#pw", "#csrf"]) {
      expect(
        dom.window.eval(
          createDesktopBrowserWorkspaceCommandScript({
            subaction: "get",
            getMode: "attr",
            attribute: "value",
            selector,
          }),
        ),
      ).toEqual({ value: null });
    }
  } finally {
    dom.window.close();
  }
  const env = {};
  const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, env);
  const url = "https://example.test/login";
  await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "network",
      networkAction: "route",
      url,
      responseBody: login,
    },
    env,
  );
  await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "navigate", url },
    env,
  );
  for (const [selector, value] of [
    ["#user", "octocat"],
    ["#pw", null],
    ["#csrf", null],
  ] as const) {
    expect(
      (
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "get", getMode: "value", selector },
          env,
        )
      ).value,
    ).toBe(value);
    expect(
      (
        await executeBrowserWorkspaceCommand(
          {
            id: tab.id,
            subaction: "get",
            getMode: "attr",
            attribute: "value",
            selector,
          },
          env,
        )
      ).value,
    ).toBe(value);
  }
});
