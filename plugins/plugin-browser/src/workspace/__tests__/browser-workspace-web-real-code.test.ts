/**
 * Real-code web workspace tests for command execution against JSDOM pages.
 */

import { once } from "node:events";
import { createServer } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  listBrowserWorkspaceTabs,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";
import { webWorkspaceState } from "../browser-workspace-state.js";

const webEnv: NodeJS.ProcessEnv = {};

const homeHtml = `<!doctype html>
<html>
  <head><title>Browser Workspace Test Shop</title></head>
  <body>
    <main>
      <h1>Browser Workspace Test Shop</h1>
      <p id="intro">Ready for a real web-mode command flow.</p>
      <a id="details-link" href="/details">View Details</a>
      <form id="search-form" action="/search" method="post">
        <label for="query">Search</label>
        <input id="query" name="query" value="" />
        <textarea id="notes" name="notes"></textarea>
        <button id="submit-search" type="submit">Submit Search</button>
      </form>
    </main>
  </body>
</html>`;

const detailsHtml = `<!doctype html>
<html>
  <head><title>Details Loaded</title></head>
  <body>
    <h1>Details Loaded</h1>
    <p id="details-copy">The details route was reached by a structured click.</p>
  </body>
</html>`;

const searchHtml = `<!doctype html>
<html>
  <head><title>Search Submitted</title></head>
  <body>
    <h1>Search Submitted</h1>
    <p id="search-result">Form submission reached the routed POST response.</p>
  </body>
</html>`;

const longSnapshotTail = "complete-snapshot-tail";
const longSnapshotHtml = `<!doctype html>
<html>
  <head><title>Complete Snapshot</title></head>
  <body><main><p>${"browser content ".repeat(80)}${longSnapshotTail}</p></main></body>
</html>`;

describe("browser workspace web-mode real-code command flow", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("keeps document fragments through real HTTP loads and form redirects", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/redirect" || url.pathname === "/submit") {
        response.writeHead(303, {
          Location: url.searchParams.get("to") ?? "/done",
        });
        response.end();
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Fragment destination</title>
        <h1 id="details">Details</h1><h2 id="receipt">Receipt</h2>
        <form method="post" action="/submit#receipt">
          <button id="submit">Submit</button>
        </form>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const [path, expected] of [
        ["/done#details", "/done#details"],
        ["/redirect#details", "/done#details"],
        ["/redirect?to=%2Fdone%23receipt#details", "/done#receipt"],
        ["/redirect?to=%2Fdone%23#details", "/done#"],
      ]) {
        const tab = await openBrowserWorkspaceTab(
          { url: `${base}${path}` },
          webEnv,
        );
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "get", selector: "title" },
          webEnv,
        );
        const loaded = (await listBrowserWorkspaceTabs(webEnv)).find(
          (entry) => entry.id === tab.id,
        );
        expect.soft(loaded?.url, path).toBe(`${base}${expected}`);
      }
      const form = await openBrowserWorkspaceTab(
        { url: `${base}/form` },
        webEnv,
      );
      const submitted = await executeBrowserWorkspaceCommand(
        { id: form.id, subaction: "click", selector: "#submit" },
        webEnv,
      );
      expect.soft(submitted.tab?.url).toBe(`${base}/done#receipt`);
      expect(requests).toContain("POST /submit");
      expect(requests.every((request) => !request.includes("#"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("sends the form encoding and preserves its body across HTTP 307", async () => {
    const submissions: { url: string; contentType: string; body: string }[] =
      [];
    const server = createServer(async (request, response) => {
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        submissions.push({
          url: request.url ?? "",
          contentType: request.headers["content-type"] ?? "",
          body: Buffer.concat(chunks).toString(),
        });
        if (request.url === "/submit") {
          response.writeHead(307, { Location: "/done" });
          response.end();
          return;
        }
      }
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Form encoding</title>
        <form method="post" action="/submit" enctype="multipart/form-data">
          <input name="query" value="hello world">
          <input name="tag" value="one"><input name="tag" value="two">
          <textarea name="notes">first\nsecond</textarea>
          <input type="file" name="attachment">
          <button id="multipart">Multipart</button>
          <button id="plain" formenctype="text/plain">Plain</button>
          <button id="fallback" formenctype="invalid">Fallback</button>
        </form>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const selector of ["#multipart", "#plain", "#fallback"]) {
        submissions.length = 0;
        const tab = await openBrowserWorkspaceTab({ url: base }, webEnv);
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "click", selector },
          webEnv,
        );
        expect(submissions.map(({ url }) => url)).toEqual(["/submit", "/done"]);
        const first = submissions[0];
        expect(submissions[1]).toEqual({ ...first, url: "/done" });
        if (selector === "#multipart") {
          expect
            .soft(first.contentType)
            .toMatch(/^multipart\/form-data; boundary=/);
          const parsed = await new Request(base, {
            method: "POST",
            headers: { "Content-Type": first.contentType },
            body: first.body,
          }).formData();
          expect.soft(parsed.get("query")).toBe("hello world");
          expect.soft(parsed.getAll("tag")).toEqual(["one", "two"]);
          expect.soft(parsed.get("notes")).toBe("first\r\nsecond");
          expect
            .soft(first.body)
            .toContain(
              'name="attachment"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n',
            );
        } else if (selector === "#plain") {
          expect.soft(first.contentType).toBe("text/plain");
          expect
            .soft(first.body)
            .toBe(
              "query=hello world\r\ntag=one\r\ntag=two\r\nnotes=first\r\nsecond\r\nattachment=\r\n",
            );
        } else {
          expect(first.contentType).toMatch(
            /^application\/x-www-form-urlencoded/,
          );
          expect
            .soft(new URLSearchParams(first.body).get("attachment"))
            .toBe("");
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("inserts keyboard text at the selection and submits the edited values", async () => {
    const submissions: URLSearchParams[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        submissions.push(new URLSearchParams(Buffer.concat(chunks).toString()));
      }
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Keyboard editing</title>
        <form method="post" action="/submit">
          <input id="query" name="query" value="hello world">
          <textarea id="notes" name="notes">first\nsecond</textarea>
          <input id="locked" name="locked" value="keep me" readonly>
          <button id="submit">Submit</button>
        </form>`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    try {
      for (const subaction of ["keyboardinserttext", "keyboardtype"] as const) {
        const tab = await openBrowserWorkspaceTab(
          { url: `http://127.0.0.1:${address.port}` },
          webEnv,
        );
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "focus", selector: "#query" },
          webEnv,
        );
        const document = webWorkspaceState.tabs.find(
          (entry) => entry.id === tab.id,
        )?.dom?.window.document;
        const query = document?.querySelector<HTMLInputElement>("#query");
        const notes = document?.querySelector<HTMLTextAreaElement>("#notes");
        if (!query || !notes) throw new Error("HTTP form did not load");
        // Focus leaves the caret after prefilled text, so typing appends.
        expect
          .soft([query.selectionStart, query.selectionEnd])
          .toEqual([11, 11]);
        // Arrange an actual DOM selection; edits and submission use commands.
        query.setSelectionRange(6, 11);
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction, value: "Korea" },
          webEnv,
        );
        expect.soft(query.value).toBe("hello Korea");
        expect
          .soft([query.selectionStart, query.selectionEnd])
          .toEqual([11, 11]);
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction, value: "!" },
          webEnv,
        );
        expect.soft(query.value).toBe("hello Korea!");
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "focus", selector: "#notes" },
          webEnv,
        );
        notes.setSelectionRange(0, 5);
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction, value: "new" },
          webEnv,
        );
        expect.soft(notes.value).toBe("new\nsecond");
        expect.soft(notes.selectionStart).toBe(3);
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "focus", selector: "#locked" },
          webEnv,
        );
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction, value: "overwrite" },
          webEnv,
        );
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "click", selector: "#submit" },
          webEnv,
        );
        const received = submissions.at(-1);
        expect.soft(received?.get("query")).toBe("hello Korea!");
        expect
          .soft(received?.get("notes")?.replace(/\r\n/g, "\n"))
          .toBe("new\nsecond");
        expect.soft(received?.get("locked")).toBe("keep me");
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("keeps navigation metadata distinct from a subsequent page read", async () => {
    const opened = await executeBrowserWorkspaceCommand(
      { subaction: "open", url: "about:blank", show: true },
      webEnv,
    );
    expect(opened.pageContentObserved).toBe(false);
    if (!opened.tab) throw new Error("Open did not return a tab");
    const id = opened.tab.id;
    await executeBrowserWorkspaceCommand(
      {
        id,
        subaction: "network",
        networkAction: "route",
        url: "https://example.test/title",
        responseBody: homeHtml,
      },
      webEnv,
    );
    const navigation = await executeBrowserWorkspaceCommand(
      {
        id,
        subaction: "navigate",
        url: "https://example.test/title",
      },
      webEnv,
    );
    expect(navigation.pageContentObserved).toBe(false);
    expect(navigation.tab?.title).toBe("example.test");
    const read = await executeBrowserWorkspaceCommand(
      {
        id,
        subaction: "get",
        selector: "title",
      },
      webEnv,
    );
    expect(read.value).toBe("Browser Workspace Test Shop");
    expect(read.pageContentObserved).not.toBe(false);
  });

  it("reads page prose without script or style payloads and leaves HTML intact", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url: "https://example.test/text",
        responseBody:
          '<html><body><h1>Rehearsal</h1><p>Keep all prose.</p><script>window.privateImplementation="script-noise";</script><style>.style-noise{color:red}</style><input name="query" value="visible-search"><input type="hidden" name="csrf" value="hidden-token"><input type="password" name="password" value="password-secret"></body></html>',
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: "https://example.test/text" },
      webEnv,
    );
    const text = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "body" },
      webEnv,
    );
    expect(text.value).toBe("Rehearsal Keep all prose.");
    const snapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );
    expect(JSON.stringify(snapshot)).not.toContain("script-noise");
    expect(JSON.stringify(snapshot)).not.toContain("style-noise");
    expect(JSON.stringify(snapshot)).toContain("visible-search");
    expect(JSON.stringify(snapshot)).not.toContain("hidden-token");
    expect(JSON.stringify(snapshot)).not.toContain("password-secret");
    const html = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "body", getMode: "html" },
      webEnv,
    );
    expect(html.value).toContain("script-noise");
    expect(html.value).toContain("style-noise");
  });

  it("separates line breaks and block elements in text reads, not inline elements", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url: "https://example.test/breaks",
        responseBody:
          '<html><body><p id="copy">First<br>Second<br><span>Third</span> <b>line</b></p><ul><li>One</li><li>Tw<i>o</i></li></ul>tail<table><tr><td>A</td><td>B</td></tr></table></body></html>',
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: "https://example.test/breaks" },
      webEnv,
    );
    const copy = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "#copy" },
      webEnv,
    );
    expect(copy.value).toBe("First Second Third line");
    const body = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "body" },
      webEnv,
    );
    expect(body.value).toBe("First Second Third line One Two tail A B");
  });

  it("navigates, clicks, types, screenshots, and extracts DOM through the command router", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );

    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: homeHtml,
        subaction: "network",
        url: "https://example.test/",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: detailsHtml,
        subaction: "network",
        url: "https://example.test/details",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: searchHtml,
        subaction: "network",
        url: "https://example.test/search",
      },
      webEnv,
    );

    const navigated = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "navigate",
        url: "https://example.test/",
      },
      webEnv,
    );
    expect(navigated).toMatchObject({
      mode: "web",
      subaction: "navigate",
      tab: {
        url: "https://example.test/",
      },
    });

    const title = await executeBrowserWorkspaceCommand(
      { getMode: "title", id: tab.id, subaction: "get" },
      webEnv,
    );
    expect(title.value).toBe("Browser Workspace Test Shop");

    const typed = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#query",
        subaction: "type",
        value: "calendar",
      },
      webEnv,
    );
    expect(typed.value).toMatchObject({
      selector: "#query",
      value: "calendar",
    });

    const filled = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#notes",
        subaction: "fill",
        value: "prefer morning slots",
      },
      webEnv,
    );
    expect(filled.value).toMatchObject({
      selector: "#notes",
      value: "prefer morning slots",
    });

    const queryValue = await executeBrowserWorkspaceCommand(
      {
        getMode: "value",
        id: tab.id,
        selector: "#query",
        subaction: "get",
      },
      webEnv,
    );
    expect(queryValue.value).toBe("calendar");

    const screenshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "screenshot" },
      webEnv,
    );
    expect(screenshot.mode).toBe("web");
    expect(screenshot.snapshot?.data).toEqual(expect.any(String));
    expect(screenshot.snapshot?.data.length).toBeGreaterThan(100);

    const clicked = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#details-link",
        subaction: "click",
      },
      webEnv,
    );
    expect(clicked).toMatchObject({
      mode: "web",
      subaction: "click",
      tab: { title: "Details Loaded", url: "https://example.test/details" },
    });

    const detailsSnapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );
    expect(detailsSnapshot.value).toMatchObject({
      bodyText: expect.stringContaining("structured click"),
      title: "Details Loaded",
      url: "https://example.test/details",
    });

    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "navigate",
        url: "https://example.test/",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#query",
        subaction: "fill",
        value: "travel",
      },
      webEnv,
    );
    const submitted = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#submit-search",
        subaction: "click",
      },
      webEnv,
    );

    expect(submitted).toMatchObject({
      mode: "web",
      subaction: "click",
      tab: { title: "Search Submitted", url: "https://example.test/search" },
    });

    const resultText = await executeBrowserWorkspaceCommand(
      {
        getMode: "text",
        id: tab.id,
        selector: "#search-result",
        subaction: "get",
      },
      webEnv,
    );
    expect(resultText.value).toBe(
      "Form submission reached the routed POST response.",
    );
  });

  it("uses document base, external form ownership, submitter data, and disabled controls", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    const pageUrl = "https://example.test/page";
    const targetUrl = "https://example.test/base/submit?q=hello&choice=go";
    const html = `<base href="https://example.test/base/">
      <a id="relative" href="details">Details</a>
      <form id="search" action="submit"><input name="q" value="hello"></form>
      <button id="external" form="search" name="choice" value="go">Go</button>
      <button id="ordinary" form="search" type="button">Not submit</button>
      <fieldset disabled><input id="disabled" type="checkbox"><legend><input id="legend" type="checkbox"></legend></fieldset>`;
    for (const [url, responseBody] of [
      [pageUrl, html],
      [targetUrl, "<h1>Submitted</h1>"],
      ["https://example.test/base/details", "<h1>Details</h1>"],
    ]) {
      await executeBrowserWorkspaceCommand(
        {
          id: tab.id,
          subaction: "network",
          networkAction: "route",
          url,
          responseBody,
        },
        webEnv,
      );
    }
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: pageUrl },
      webEnv,
    );
    await expect(
      executeBrowserWorkspaceCommand(
        { id: tab.id, subaction: "click", selector: "#disabled" },
        webEnv,
      ),
    ).rejects.toThrow(/disabled/);
    const legend = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "click", selector: "#legend" },
      webEnv,
    );
    expect(legend.value).toMatchObject({ checked: true });
    const ordinary = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "click", selector: "#ordinary" },
      webEnv,
    );
    expect(ordinary.value).toMatchObject({ text: "Not submit" });
    const submitted = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "click", selector: "#external" },
      webEnv,
    );
    expect(submitted.tab?.url).toBe(targetUrl);
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: pageUrl },
      webEnv,
    );
    const followed = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "click", selector: "#relative" },
      webEnv,
    );
    expect(followed.tab?.url).toBe("https://example.test/base/details");
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url: "https://example.test/empty",
        responseStatus: 204,
      },
      webEnv,
    );
    await expect(
      executeBrowserWorkspaceCommand(
        {
          id: tab.id,
          subaction: "navigate",
          url: "https://example.test/empty",
        },
        webEnv,
      ),
    ).resolves.toMatchObject({ tab: { url: "https://example.test/empty" } });
  });

  it("preserves Enter editing and explicit submitter behavior", async () => {
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
    const page = "https://example.test/compose";
    const destination = "https://example.test/save?body=&subject=&choice=draft";
    const html = `<form id="compose" action="/send" method="post">
      <textarea id="body" name="body"></textarea><input id="subject" name="subject">
      <button id="save" name="choice" value="draft" formaction="/save" formmethod="get">Save</button>
      </form><form id="multiple"><input id="first"><input></form>
      <form id="blocked"><input id="blocked-input"><button disabled>Disabled</button></form>`;
    for (const [url, responseBody] of [
      [page, html],
      [destination, "<h1>Saved</h1>"],
    ]) {
      await executeBrowserWorkspaceCommand(
        {
          id: tab.id,
          subaction: "network",
          networkAction: "route",
          url,
          responseBody,
        },
        webEnv,
      );
    }
    const navigate = () =>
      executeBrowserWorkspaceCommand(
        { id: tab.id, subaction: "navigate", url: page },
        webEnv,
      );
    const press = (selector: string) =>
      executeBrowserWorkspaceCommand(
        { id: tab.id, subaction: "press", selector, key: "Enter" },
        webEnv,
      );
    await navigate();
    await press("#body");
    const body = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "#body", getMode: "value" },
      webEnv,
    );
    expect(body.value).toBe("\n");
    await navigate();
    expect((await press("#save")).tab?.url).toBe(destination);
    await navigate();
    expect((await press("#subject")).tab?.url).toBe(destination);
    await navigate();
    await press("#first");
    await press("#blocked-input");
    const title = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "#body", getMode: "value" },
      webEnv,
    );
    expect(title.value).toBe("");
  });

  it("checks form constraints before HTTP submission and honors explicit validation bypasses", async () => {
    const submissions: Array<{ method: string; email: string | null }> = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "text/html");
      if (url.pathname === "/subscribe") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const fields =
          request.method === "POST"
            ? new URLSearchParams(body)
            : url.searchParams;
        submissions.push({
          method: request.method ?? "GET",
          email: fields.get("email"),
        });
        response.end("<h1>Subscribed</h1>");
        return;
      }
      const method = url.searchParams.get("method") === "get" ? "get" : "post";
      response.end(`<form action="/subscribe" method="${method}" ${url.searchParams.has("novalidate") ? "novalidate" : ""}>
        <input id="email" name="email" type="email" required>
        <input required disabled>
        <button id="send">Subscribe</button>
        <button id="draft" formnovalidate>Save draft</button>
        </form><dialog open><form method="dialog">
        <input id="reason" required><button id="close">Close</button>
        </form></dialog>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("No HTTP port");
      const origin = `http://127.0.0.1:${address.port}`;
      for (const method of ["post", "get"] as const) {
        const url = `${origin}/form?method=${method}`;
        const tab = await openBrowserWorkspaceTab({ url }, webEnv);
        const run = (
          command: Parameters<typeof executeBrowserWorkspaceCommand>[0],
        ) => executeBrowserWorkspaceCommand({ ...command, id: tab.id }, webEnv);
        const submit = () =>
          run(
            method === "post"
              ? { subaction: "click", selector: "#send" }
              : { subaction: "press", selector: "#email", key: "Enter" },
          );
        const blocked = await submit();
        expect(submissions).toEqual([]);
        // The agent learns which field blocked the submission.
        expect(blocked.value).toMatchObject({
          submitted: false,
          invalid: { message: expect.any(String) },
        });
        await run({
          subaction: "fill",
          selector: "#email",
          value: "not-an-email",
        });
        await submit();
        expect(submissions).toEqual([]);
        expect(
          (
            await run({
              subaction: "get",
              selector: "#email",
              getMode: "value",
            })
          ).value,
        ).toBe("not-an-email");
        await run({
          subaction: "fill",
          selector: "#email",
          value: "person@example.test",
        });
        await submit();
        expect(submissions.splice(0)).toEqual([
          { method: method.toUpperCase(), email: "person@example.test" },
        ]);
      }
      for (const formBypass of [false, true]) {
        const tab = await openBrowserWorkspaceTab(
          { url: `${origin}/form${formBypass ? "?novalidate" : ""}` },
          webEnv,
        );
        await executeBrowserWorkspaceCommand(
          {
            id: tab.id,
            subaction: "click",
            selector: formBypass ? "#send" : "#draft",
          },
          webEnv,
        );
        expect(submissions.splice(0)).toEqual([{ method: "POST", email: "" }]);
      }
      const tab = await openBrowserWorkspaceTab(
        { url: `${origin}/form` },
        webEnv,
      );
      const run = (
        command: Parameters<typeof executeBrowserWorkspaceCommand>[0],
      ) => executeBrowserWorkspaceCommand({ ...command, id: tab.id }, webEnv);
      await run({ subaction: "click", selector: "#close" });
      expect(
        (
          await run({
            subaction: "get",
            selector: "dialog",
            getMode: "attr",
            attribute: "open",
          })
        ).value,
      ).toBe("");
      await run({ subaction: "fill", selector: "#reason", value: "Done" });
      await run({ subaction: "click", selector: "#close" });
      expect(
        (
          await run({
            subaction: "get",
            selector: "dialog",
            getMode: "attr",
            attribute: "open",
          })
        ).value,
      ).toBeNull();
      expect(submissions).toEqual([]);
    } finally {
      await __resetBrowserWorkspaceStateForTests();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("restores form defaults before sending a real HTTP request after reset", async () => {
    const submitted: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "text/html");
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        submitted.push(body);
        response.end("<h1>Saved</h1>");
        return;
      }
      response.end(`<form id="edit" method="post" action="/save">
        <input id="title" name="title" value="Original">
        <textarea id="body" name="body">Keep this</textarea>
        <input id="notify" name="notify" type="checkbox" checked>
        <button id="reset-button" type="reset">Reset</button>
        <input id="reset-input" type="reset">
        <button id="disabled-reset" type="reset" disabled>Disabled reset</button>
        <button id="save">Save</button>
        </form><button id="external-reset" type="reset" form="edit">Reset externally</button>
        <form><input id="other" value="Other form"></form>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("No HTTP port");
      const url = `http://127.0.0.1:${address.port}/edit`;
      for (const [selector, subaction] of [
        ["#reset-button", "click"],
        ["#reset-input", "click"],
        ["#external-reset", "press"],
      ] as const) {
        const tab = await openBrowserWorkspaceTab({ url }, webEnv);
        const run = (
          command: Parameters<typeof executeBrowserWorkspaceCommand>[0],
        ) => executeBrowserWorkspaceCommand({ ...command, id: tab.id }, webEnv);
        await run({ subaction: "fill", selector: "#title", value: "Wrong" });
        await run({
          subaction: "fill",
          selector: "#body",
          value: "Discard me",
        });
        await run({ subaction: "type", selector: "#title", value: " draft" });
        await run({ subaction: "uncheck", selector: "#notify" });
        await run({
          subaction: "fill",
          selector: "#other",
          value: "Keep other edit",
        });
        await expect(
          run({ subaction: "click", selector: "#disabled-reset" }),
        ).rejects.toThrow(/disabled/);
        expect(
          (
            await run({
              subaction: "get",
              selector: "#title",
              getMode: "value",
            })
          ).value,
        ).toBe("Wrong draft");
        await run({ subaction, selector, key: "Enter" });
        expect(submitted).toHaveLength(0);
        expect(
          (
            await run({
              subaction: "get",
              selector: "#title",
              getMode: "value",
            })
          ).value,
        ).toBe("Original");
        expect(
          (await run({ subaction: "get", selector: "#body", getMode: "value" }))
            .value,
        ).toBe("Keep this");
        expect(
          (
            await run({
              subaction: "get",
              selector: "#other",
              getMode: "value",
            })
          ).value,
        ).toBe("Keep other edit");
        await run({ subaction: "click", selector: "#save" });
        expect(submitted.splice(0)).toEqual([
          "title=Original&body=Keep+this&notify=on",
        ]);
      }
    } finally {
      await __resetBrowserWorkspaceStateForTests();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("closes a method=dialog form without a request and sends an invalid method as GET", async () => {
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
    const page = "https://example.test/confirm";
    const html = `<dialog open><form method="dialog"><button id="ok" value="yes">OK</button></form></dialog>
      <form action="/item" method="put"><input name="q" value="1"><button id="put">Go</button></form>`;
    for (const [url, responseBody] of [
      [page, html],
      ["https://example.test/item?q=1", "<h1>Item</h1>"],
    ]) {
      await executeBrowserWorkspaceCommand(
        {
          id: tab.id,
          subaction: "network",
          networkAction: "route",
          url,
          responseBody,
        },
        webEnv,
      );
    }
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: page },
      webEnv,
    );
    const clicked = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "click", selector: "#ok" },
      webEnv,
    );
    expect(clicked.tab?.url).toBe(page);
    const openDialogs = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "get",
        selector: "dialog[open]",
        getMode: "count",
      },
      webEnv,
    );
    expect(openDialogs.value).toBe(0);
    const requests = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "network", networkAction: "requests" },
      webEnv,
    );
    expect(
      (requests.value as Array<{ method: string; url: string }>).map(
        (request) => `${request.method} ${request.url}`,
      ),
    ).toEqual([`GET ${page}`]);

    const put = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "click", selector: "#put" },
      webEnv,
    );
    expect(put.tab?.url).toBe("https://example.test/item?q=1");
  });

  it("preserves semantic page content beyond the former fixed snapshot ceiling", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: longSnapshotHtml,
        subaction: "network",
        url: "https://example.test/complete-snapshot",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "navigate",
        url: "https://example.test/complete-snapshot",
      },
      webEnv,
    );

    const snapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );

    expect(snapshot.value?.bodyText).toContain(longSnapshotTail);
    expect(snapshot.value?.bodyText?.length).toBeGreaterThan(800);
  });

  it("scrolls and hovers a routed page through the command router (#18259)", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: homeHtml,
        subaction: "network",
        url: "https://example.test/",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: "https://example.test/" },
      webEnv,
    );

    const scrolledDown = await executeBrowserWorkspaceCommand(
      { direction: "down", id: tab.id, pixels: 480, subaction: "scroll" },
      webEnv,
    );
    expect(scrolledDown.mode).toBe("web");
    expect(scrolledDown.value).toMatchObject({ axis: "y", value: 480 });

    const scrolledUp = await executeBrowserWorkspaceCommand(
      { direction: "up", id: tab.id, pixels: 200, subaction: "scroll" },
      webEnv,
    );
    expect(scrolledUp.value).toMatchObject({ axis: "y", value: 280 });

    const hovered = await executeBrowserWorkspaceCommand(
      { id: tab.id, selector: "#details-link", subaction: "hover" },
      webEnv,
    );
    expect(hovered.mode).toBe("web");
    expect(hovered.value).toMatchObject({
      hovered: true,
      selector: "#details-link",
    });
  });
});

describe("browser workspace web-mode label click", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("checks the control that a clicked label names or wraps", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    const url = "https://example.test/consent";
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url,
        responseBody: `<label>Remember me <input id="remember" type="checkbox" /></label>
<input id="terms" type="checkbox" /><label for="terms">I agree to the terms</label>`,
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url },
      webEnv,
    );
    for (const [text, selector] of [
      ["Remember me", "#remember"],
      ["I agree to the terms", "#terms"],
    ]) {
      const clicked = await executeBrowserWorkspaceCommand(
        { id: tab.id, subaction: "click", text },
        webEnv,
      );
      expect(clicked.value, text).toMatchObject({ checked: true, selector });
    }
  });
});
