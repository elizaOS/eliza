import type { IAgentRuntime, Memory } from "@elizaos/core";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluateBrowserWorkspaceTab = vi.fn();

vi.mock("../workspace/browser-workspace.js", () => ({
  isBrowserWorkspaceBridgeConfigured: () => true,
  listBrowserWorkspaceTabs: async () => [
    {
      id: "tab-1",
      title: "Login",
      url: "https://example.test/login",
      partition: "persist:main",
      kind: "standard",
      visible: true,
      createdAt: 0,
      updatedAt: 0,
      lastFocusedAt: 0,
    },
  ],
  evaluateBrowserWorkspaceTab: (request: { script: string }) =>
    evaluateBrowserWorkspaceTab(request),
}));

vi.mock("@elizaos/auth/vault", () => ({
  createManager: () => ({ vault: {} }),
  getAutofillAllowed: async () => true,
  getSavedLogin: async () => ({
    username: "ada@example.test",
    password: "hunter2",
    lastModified: 1,
  }),
  listSavedLogins: async () => [
    { username: "ada@example.test", lastModified: 1 },
  ],
}));

const { executeBrowserAutofillLogin } = await import(
  "./browser-autofill-login.js"
);

/** Run the production snippet inside a real DOM, as the tab eval transport does. */
function servePage(html: string) {
  const dom = new JSDOM(html, {
    url: "https://example.test/login",
    runScripts: "outside-only",
  });
  evaluateBrowserWorkspaceTab.mockImplementation(
    ({ script }: { script: string }) => dom.window.eval(script) as unknown,
  );
  return dom;
}

const runtime = { getService: () => null } as unknown as IAgentRuntime;
const message = { content: { text: "" } } as Memory;

async function autofill() {
  return executeBrowserAutofillLogin(runtime, message, {
    parameters: { domain: "example.test", submit: true },
  });
}

beforeEach(() => {
  evaluateBrowserWorkspaceTab.mockReset();
});

describe("BROWSER autofill-login submission receipt", () => {
  it("reports the control that blocked the submission", async () => {
    const dom = servePage(`<!doctype html><html><body>
			<form action="/session" method="post">
				<input type="email" name="user">
				<input type="password" name="pass">
				<input type="text" name="tenant" required>
			</form>
		</body></html>`);
    let submitted = false;
    dom.window.document
      .querySelector("form")
      ?.addEventListener("submit", () => {
        submitted = true;
      });

    const result = await autofill();

    expect(submitted).toBe(false);
    expect(result.values?.submitted).toBe(false);
    expect(result.values?.invalid).toEqual({
      name: "tenant",
      message: expect.any(String),
    });
    expect(result.text).toContain("did not submit");
    expect(result.text).toContain("tenant");
  });

  it("does not claim a submission when the page has no submit control", async () => {
    const dom = servePage(`<!doctype html><html><body>
			<div><input type="text" name="user"><input type="password" name="pass"></div>
		</body></html>`);
    let submitted = false;
    dom.window.document.addEventListener("submit", () => {
      submitted = true;
    });

    const result = await autofill();

    expect(submitted).toBe(false);
    expect(result.values?.submitted).toBe(false);
    expect(result.text).toContain("did not submit");
  });

  it("still reports a submission the page accepted", async () => {
    const dom = servePage(`<!doctype html><html><body>
			<form action="/session" method="post">
				<input type="email" name="user">
				<input type="password" name="pass">
				<button type="submit">Sign in</button>
			</form>
		</body></html>`);
    let submitted = false;
    dom.window.document
      .querySelector("form")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        submitted = true;
      });

    const result = await autofill();

    expect(submitted).toBe(true);
    expect(result.values?.submitted).toBe(true);
    expect(result.text).toContain("submitted");
  });
});
