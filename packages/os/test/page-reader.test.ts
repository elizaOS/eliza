// spec/os/browser/pageCommands.md, "Story: Run a website task step only on the page it was planned for"; spec/os/browser/pageCommands.md, "An observation belongs to the live binding it was read under, and a read or an input holds none"
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Schema } from "effect";
import { chromium, type Browser, type CDPSession, type Locator, type Page } from "playwright";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { createCommandHandler } from "../browser/src/command-handler.mjs";
import { nativeControlProgram } from "./drivers/os__browser__pageCommands.ts";

const shop = "https://shop.example";
const partner = "https://pay.example";
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const fields = Schema.decodeUnknownSync(Fields);
const text = Schema.decodeUnknownSync(Schema.String);
const strings = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const source = (file: string, name: string) =>
  text(runInNewContext(`${readFileSync(new URL(`../browser/src/${file}`, import.meta.url), "utf8").replace(/^export /gm, "")}\n${name}.toString()`));
const pageCommand = source("page-command.mjs", "pageCommand");
const embedded = (file: string, name: string, contents = readFileSync(new URL(file, import.meta.url), "utf8")) => {
  const parsed = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const find = (node: ts.Node): ts.FunctionDeclaration | ts.FunctionExpression | undefined =>
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name ? node : ts.forEachChild(node, find);
  const found = find(parsed);
  if (!found?.body) throw new Error(`${name} is not in ${file}`);
  const tokens = (node: ts.Node): string[] =>
    node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode ? [] : node.getChildCount(parsed) === 0 ? [node.getText(parsed)] : node.getChildren(parsed).flatMap(tokens);
  const all = [...found.parameters.flatMap(tokens), "|", ...tokens(found.body)];
  return { text: found.getText(parsed), tokens: all.filter((token, index) => token !== "," || ![")", "]", "}"].includes(all[index + 1] ?? "")) };
};
const channel = nativeControlProgram();
const pageGuidance = source("page-guidance.mjs", "pageGuidance");
const Read = Schema.Struct({ complete: Schema.Literal(true), text: Schema.String, elements: Schema.Array(Fields) });
const Box = Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number });
type Fields = typeof Fields.Type;
interface Snapshot { readonly id: string; readonly value: Fields; readonly elements: readonly Fields[]; readonly text: string }

const pressed = `<script>window.top.pressed ??= [];document.addEventListener("click", (event) => {const control = event.composedPath().find((node) => node.matches?.("button,a,input"));if (control) window.top.pressed.push(control.id);}, true);</script>`;
const page = (body: string) =>
  `<!doctype html><html lang="en"><style>body{font:18px system-ui;margin:16px}label,button,input{display:block;margin:6px 0}</style>${body}${pressed}</html>`;
const cardForm = (words: string, money = "<p>Total $84.20</p>") =>
  page(`<form action="/paid" method="get"><label>Card number <input id="card" autocomplete="cc-number"></label><label>Security code <input id="cvc"></label><button type="button" id="details">Show details</button><button id="frame-pay">Pay now</button></form>${money}<p>${words}</p>`);
const secure = "https://secure.codes.example";
const field = `<script>customElements.define("bank-field", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<label for="input">' + this.getAttribute("label") + '</label><input id="input" name="' + this.id + '" type="' + (this.getAttribute("type") ?? "text") + '">'; } });</script>`;
const logon = (frame: string) =>
  page(`<h1>Sign in</h1><iframe name="logonbox" title="logon" src="${frame}?fromOrigin=${secure}" style="position:absolute;left:0;top:0;width:100%;height:100%;border:0"></iframe><iframe title="empty" src="/empty" style="position:absolute;left:0;top:-5000px;width:0;height:0;border:0"></iframe>`);
const pages: Record<string, string> = {
  [`${shop}/signin`]: page(`<h1>Welcome back</h1><northfield-login></northfield-login><sealed-box></sealed-box><script>
    customElements.define("northfield-login", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<form><label>Username <input id="shadow-user" name="username"></label><label>Password <input id="shadow-pass" type="password"></label><button type="button" id="shadow-next">Next</button><p id="echo"></p></form>'; } });
    customElements.define("sealed-box", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "closed" }).innerHTML = '<label>Closed field <input id="closed-field"></label><button type="button" id="closed-button">Closed button</button><p>Sealed words</p>'; } });
  </script>`),
  [`${shop}/pay`]: page(`<h1>Make a payment</h1><p>Amount due $84.20</p><iframe id="card-frame" src="/card-frame" title="Secure payment form" style="width:520px;height:330px;border:4px solid #333;padding:6px"></iframe><iframe id="other-frame" src="${partner}/card-frame" title="Partner payment form" style="width:520px;height:330px"></iframe>`),
  [`${shop}/card-frame`]: cardForm("Card words"),
  [`${partner}/card-frame`]: cardForm("Partner words"),
  [`${shop}/framed-plain`]: page(`<h1>Newsletter</h1><iframe id="plain-frame" src="/plain-frame" title="Sign up form" style="width:520px;height:260px"></iframe>`),
  [`${shop}/plain-frame`]: page(`<label>Email <input id="email" type="email"></label><label>How often <select id="often"><option>Weekly</option><option>Monthly</option></select></label><a id="terms" href="/terms">Our terms</a><button type="button" id="details">Show details</button>`),
  [`${shop}/card-only`]: page(`<button type="button" id="top-details">Show details</button><iframe id="card-frame" src="/card-frame-plain" title="Card"></iframe>`),
  [`${shop}/card-frame-plain`]: cardForm("Card words", ""),
  [`${shop}/framed-modal`]: page(`<h1>Your account</h1><iframe id="modal-frame" src="/modal-frame" title="Account" style="position:absolute;left:0;top:0;width:100%;height:100%;border:0"></iframe>`),
  [`${shop}/modal-frame`]: page(`<form><label>Email <input id="email" type="email"></label><button type="button" id="details">Show details</button></form><div role="dialog" aria-modal="true" aria-label="Session" style="position:fixed;left:0;top:0;right:0;bottom:0;background:#fff">Your session is about to end.<button type="button" id="stay">Close</button></div>`),
  [`${shop}/shadow-consent`]: page(`<h1>Opening hours</h1><p>Our branches open at nine.</p><consent-layer></consent-layer><script>customElements.define("consent-layer", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<div id="cookie-banner" style="position:fixed;left:0;right:0;bottom:0;height:140px;background:#eee">We use cookies.<button type="button" id="reject">Reject all</button><button type="button" id="accept">Accept all</button></div>'; } });</script>`),
  [`${shop}/covered`]: page(`<iframe id="plain-frame" src="/plain-frame" title="Sign up form" style="width:400px;height:200px"></iframe><p>Below the frame are our opening hours, our address and a map of the branch offices.</p><div role="dialog" aria-label="Notice" style="position:fixed;left:0;top:0;width:440px;height:240px;background:#fff">Please read this notice<button type="button" id="close-notice">Close</button></div>`),
  [`${secure}/dashboard`]: logon("/auth/"),
  [`${secure}/auth/`]: `<form id="logon" action="/auth/logon" method="post"><bank-field id="userId" label="Username"></bank-field><bank-field id="password" label="Password" type="password"></bank-field><label>Sign in with <select id="token"><option>Password</option><option>Token</option></select></label><a id="forgot" href="/auth/forgot">Forgot username or password?</a><button type="button" id="signin">Sign in</button></form>${field}`,
  [`${secure}/empty`]: `<title>empty</title><button type="button" id="beacon">Telemetry</button><script>document.body.style.width = "4000px";</script>`,
};


let browser: Browser;
let tab: Page;
let cdp: CDPSession;
let world: { loaderId: string; id: number } | undefined;
let sequence = 0;

let launched: Promise<void> | undefined;
const launch = () =>
  (launched ??= (async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route(/^https:\/\/[a-z.]+\.example\//, (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: pages[`${url.origin}${url.pathname}`] ?? page("<p>Received</p>") });
    });
    tab = await context.newPage();
    cdp = await context.newCDPSession(tab);
  })());
afterAll(async () => {
  if (launched) await browser.close();
});

const mainFrame = async () => (await cdp.send("Page.getFrameTree")).frameTree.frame;
const realm = async () => {
  const frame = await mainFrame();
  if (world?.loaderId !== frame.loaderId) {
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "page-reader-test" });
    world = { loaderId: frame.loaderId, id: executionContextId };
  }
  return world.id;
};
const evaluate = async (expression: string, contextId?: number): Promise<unknown> => {
  const result = await cdp.send("Runtime.evaluate", { contextId: contextId ?? (await realm()), expression, returnByValue: true, awaitPromise: true });
  expect(result.exceptionDetails).toBeUndefined();
  return result.result.value;
};
interface FrameTree { readonly frame: { readonly id: string; readonly loaderId: string }; readonly childFrames?: readonly FrameTree[] }
const frameList = async () => {
  const flat = (tree: FrameTree): FrameTree[] => [tree, ...(tree.childFrames ?? []).flatMap(flat)];
  return flat((await cdp.send("Page.getFrameTree")).frameTree).map(({ frame }, frameId) => ({
    frameId,
    documentId: frame.loaderId,
    contextId: async () => frameId === 0 ? realm() : (await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "page-reader-test" })).executionContextId,
  }));
};
const surface = async () => {
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: (await mainFrame()).id, worldName: `eliza-surface-control-${++sequence}` });
  await evaluate("globalThis.elizaSurfaceControl = { replies: [], postMessage(value) { this.replies.push(JSON.parse(value)); } }", executionContextId);
  await evaluate(channel, executionContextId);
  const documentId = text(fields(await evaluate("elizaSurfaceControl.replies.find((reply) => reply.ready)", executionContextId)).documentId);
  let count = 0;
  return async (command: Fields) => {
    const number = ++count;
    await evaluate(`elizaSurfaceControl.onmessage({ data: ${JSON.stringify(JSON.stringify({ documentId, sequence: number, command }))} })`, executionContextId);
    await expect.poll(() => evaluate(`elizaSurfaceControl.replies.some((reply) => reply.sequence === ${number})`, executionContextId)).toBe(true);
    return fields(fields(await evaluate(`elizaSurfaceControl.replies.find((reply) => reply.sequence === ${number})`, executionContextId)).result);
  };
};
const call = (run: string, args: readonly unknown[]) => evaluate(`(${run})(...${JSON.stringify(args)})`);
const open = async (url: string) => {
  await launch();
  await tab.goto(url);
  await realm();
};
const snapshot = async (extra: Fields = {}): Promise<Snapshot> => {
  const id = `snapshot-${++sequence}`;
  const raw = await call(pageCommand, [{ subaction: "snapshot", ...extra }, id]);
  const read = Schema.decodeUnknownSync(Read)(raw);
  return { id, value: fields(raw), elements: read.elements, text: read.text };
};
const find = (state: Snapshot, label: string) => {
  const found = state.elements.find((element) => element.label === label);
  expect(found, `${label} in ${JSON.stringify(state.elements.map((element) => element.label))}`).toBeDefined();
  return fields(found);
};
const selectorOf = (element: Fields) => text(element.targetSelector);
const act = async (state: Snapshot, subaction: string, label: string, extra: Fields = {}) =>
  fields(await call(pageCommand, [{ subaction, snapshotId: state.id, nodeId: find(state, label).id, ...extra }, null]));
const refusal = async (state: Snapshot, subaction: string, label: string, extra: Fields = {}) =>
  fields((await act(state, subaction, label, extra)).error).kind;
const policy = (selector: string, action = "click", origin = shop) =>
  ({ origin, expiresAt: Date.now() + 60_000, targets: [{ selector, action }], expectedSelector: selector, guidanceScope: "1" });
const presses = async () => strings(await tab.evaluate("window.pressed ?? []"));
const near = async (actual: unknown, locator: Locator) => {
  const shown = Schema.decodeUnknownSync(Box)(await locator.boundingBox());
  const drawn = Schema.decodeUnknownSync(Box)(actual);
  expect(Math.max(...(["x", "y", "width", "height"] as const).map((key) => Math.abs(drawn[key] - shown[key])))).toBeLessThanOrEqual(1);
};
const guided = () => evaluate("globalThis.__elizaPageGuidanceV1?.visible === true");
const guide = async (state: Snapshot, label: string) =>
  fields(await call(pageGuidance, [{ kind: "show", id: `guide-${++sequence}`, snapshotId: state.id, nodeId: find(state, label).id, origin: shop, expiresAt: Date.now() + 30_000, text: "This is the place." }]));
const ring = () => evaluate("(() => { const r = globalThis.__elizaPageGuidanceV1.shadow.querySelector('.ring').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()");

describe('The WebView runs the page reader Chromium runs (spec/os/browser/pageCommands.md, "Story: Run a website task step only on the page it was planned for")', () => {
  it("embeds page-command.mjs and page-guidance.mjs token for token", () => {
    const same = (file: string, name: string) => JSON.stringify(embedded("control-channel.js", name, channel).tokens) === JSON.stringify(embedded(`../browser/src/${file}`, name).tokens);
    expect({ pageCommand: same("page-command.mjs", "pageCommand"), pageGuidance: same("page-guidance.mjs", "pageGuidance") }).toEqual({ pageCommand: true, pageGuidance: true });
  });

  it("answers a snapshot through installControlChannel in its own isolated world as page-command.mjs does", async () => {
    const shape = (raw: unknown) => {
      const read = fields(raw);
      return { elements: Schema.decodeUnknownSync(Schema.Array(Fields))(read.elements).map(({ label, targetSelector, sensitive, frame, inShadowRoot }) => ({ label, targetSelector, sensitive, frame, inShadowRoot })), childFrames: read.childFrames, blockers: read.blockers };
    };
    for (const url of [`${shop}/signin`, `${shop}/pay`, `${secure}/dashboard`]) {
      await open(url);
      const send = await surface();
      const read = await send({ subaction: "snapshot" });
      expect(text(read.snapshotId), url).toMatch(/^[0-9a-f-]{36}$/);
      expect(shape(read), url).toEqual(shape((await snapshot()).value));
    }
  });
});

describe('A task reads open shadow roots and frames on the page\'s origin (spec/os/browser/pageCommands.md, "An observation belongs to the live binding it was read under, and a read or an input holds none")', () => {
  it("reads an open shadow root's sign-in form with the password marked and no values, and never a closed root", async () => {
    await open(`${shop}/signin`);
    await snapshot();
    await tab.locator("#shadow-user").fill("reader-value");
    await tab.locator("#shadow-pass").fill("hunter2-secret");
    await tab.evaluate(`document.querySelector("northfield-login").shadowRoot.getElementById("echo").textContent = "hunter2-secret"`);
    const state = await snapshot();
    expect(find(state, "Username")).toMatchObject({ inShadowRoot: true, sensitive: null, hasInput: true, edited: true });
    expect(find(state, "Password")).toMatchObject({ sensitive: "password", hasInput: true });
    expect(selectorOf(find(state, "Next"))).toMatch(/ >>> #shadow-next$/);
    expect(find(state, "Next").frame).toBeUndefined();
    expect(JSON.stringify(state.value)).not.toMatch(/reader-value|hunter2-secret|Sealed words/);
    expect(state.text).toContain("[hidden]");
    expect(state.text).toContain("Welcome back");
    expect(state.value.childFrames).toEqual([]);
    expect(state.elements.filter((element) => ["Closed field", "Closed button"].includes(text(element.label)) || String(element.targetSelector).includes("closed"))).toEqual([]);
  });

  it("lets a task click reach the shadow root's control by its stepped selector, once", async () => {
    await open(`${shop}/signin`);
    let state = await snapshot();
    const next = selectorOf(find(state, "Next"));
    expect(await act(state, "click", "Next", { taskPolicy: policy(next) })).toMatchObject({ dispatched: true });
    expect(await presses()).toEqual(["shadow-next"]);
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    state = await snapshot();
    for (const selector of [`${next.split(" >>> ")[0]} >>> #shadow-user`, "sealed-box >>> #closed-button", "#shadow-next"])
      expect(await refusal(state, "click", "Next", { taskPolicy: policy(selector) }), selector).toBe("POLICY_BLOCKED");
    expect(await presses()).toEqual(["shadow-next"]);
  });

  it("makes references stale on a change, a new shadow root or typing inside the shadow root", async () => {
    await open(`${shop}/signin`);
    let state = await snapshot();
    await tab.evaluate(`document.querySelector("northfield-login").shadowRoot.querySelector("form").append("Checking")`);
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    state = await snapshot();
    await tab.evaluate(`document.querySelector("h1").attachShadow({ mode: "open" })`);
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    state = await snapshot();
    await tab.locator("#shadow-user").press("End");
    await tab.keyboard.type("x");
    expect(await refusal(state, "click", "Next")).toBe("STALE_REF");
    expect(await presses()).toEqual([]);
  });

  it("reads a same-origin frame's payment form with its frame and origin, card boxes marked, and never another origin's frame", async () => {
    await open(`${shop}/pay`);
    const card = tab.frameLocator("#card-frame").locator("#card");
    await card.fill("4111111111111111");
    const state = await snapshot({ taskPolicy: policy("#none") });
    const box = find(state, "Card number");
    expect(box).toMatchObject({ sensitive: "payment-card", hasInput: true, inViewport: true, frame: { index: 1, origin: shop, title: "Secure payment form" } });
    expect(find(state, "Security code").sensitive).toBe("payment-card");
    await near(box.bounds, card);
    const pay = find(state, "Pay now");
    expect(pay).toMatchObject({ submits: true, frame: { index: 1 }, form: { index: 0 } });
    expect(selectorOf(pay)).toMatch(/^#card-frame >>> /);
    expect(state.elements.filter((element) => element.label === "Card number")).toHaveLength(1);
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(state.value.childFrames).map(({ bounds: _, ...frame }) => frame)).toEqual([
      { index: 1, read: true, origin: shop, parent: null, title: "Secure payment form" },
      { index: 2, read: false, reason: "other-origin", origin: null, parent: null, title: "Partner payment form" },
    ]);
    expect(state.value.omitted).toContain("the contents of frames on another origin (childFrames)");
    expect(state.text).toContain("Card words");
    expect(JSON.stringify(state.value)).not.toMatch(/Partner words|4111111111111111/);
  });

  it("keeps a frame's Pay button hers, and counts a card box or amount in a frame as money for the click guard", async () => {
    await open(`${shop}/pay`);
    let state = await snapshot({ taskPolicy: policy("#none") });
    expect(await refusal(state, "click", "Pay now", { taskPolicy: policy(selectorOf(find(state, "Pay now"))) })).toBe("POLICY_BLOCKED");
    state = await snapshot({ taskPolicy: policy("#none") });
    expect(await refusal(state, "click", "Show details", { taskPolicy: policy(selectorOf(find(state, "Show details"))) })).toBe("POLICY_BLOCKED");
    expect(await presses()).toEqual([]);
    await open(`${shop}/card-only`);
    state = await snapshot({ taskPolicy: policy("#top-details") });
    expect(await refusal(state, "click", "Show details", { taskPolicy: policy("#top-details") })).toBe("POLICY_BLOCKED");
    expect(await presses()).toEqual([]);
    await tab.locator("#card-frame").evaluate((frame) => { frame.style.opacity = "0"; });
    const hidden = await snapshot();
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(hidden.value.childFrames)[0]).toMatchObject({ read: false, reason: "not-rendered" });
    const top = find(hidden, "Show details");
    await tab.frameLocator("#card-frame").locator("body").evaluate((body) => { body.append("Changed after the frame was hidden"); });
    expect(await act(hidden, "click", "Show details", { taskPolicy: policy(selectorOf(top)) })).toMatchObject({ dispatched: true });
    expect(await presses()).toEqual(["top-details"]);
  });

  it("clicks in the frame only, refuses a fill, select or follow there, and stops the frame's own page change", async () => {
    await open(`${shop}/framed-plain`);
    let state = await snapshot();
    const details = find(state, "Show details");
    expect(details.frame).toMatchObject({ index: 1 });
    expect(await act(state, "click", "Show details", { taskPolicy: policy(selectorOf(details)) })).toMatchObject({ dispatched: true });
    expect(await presses()).toEqual(["details"]);
    state = await snapshot();
    expect(await refusal(state, "fill", "Email", { text: "reader@example.test", taskPolicy: policy(selectorOf(find(state, "Email")), "fill") })).toBe("POLICY_BLOCKED");
    expect(await refusal(state, "select", "How often", { text: "Monthly", taskPolicy: policy(selectorOf(find(state, "How often")), "select") })).toBe("POLICY_BLOCKED");
    expect(await refusal(state, "follow", "Our terms", { taskPolicy: policy(selectorOf(find(state, "Our terms")), "follow") })).toBe("POLICY_BLOCKED");
    const frame = tab.frameLocator("#plain-frame");
    expect([await frame.locator("#email").inputValue(), await frame.locator("#often").inputValue(), tab.frames()[1]?.url()]).toEqual(["", "Weekly", `${shop}/plain-frame`]);
    await tab.evaluate(`document.getElementById("plain-frame").contentWindow.location.assign("/paid")`);
    await expect.poll(async () => (await snapshot({ taskPolicy: policy("#none") })).value.effectViolation).toBe("navigation");
    expect(tab.frames().find((frame) => frame.parentFrame() !== null)?.url()).toBe(`${shop}/plain-frame`);
  });

  it("makes references stale on a frame's change, input, address or origin, then lists the frame unread", async () => {
    await open(`${shop}/framed-plain`);
    let state = await snapshot();
    await tab.evaluate(`document.getElementById("plain-frame").contentDocument.body.append("Changed")`);
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    await tab.frameLocator("#plain-frame").locator("#email").fill("typed");
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    await tab.evaluate(`document.getElementById("plain-frame").contentWindow.history.pushState(null, "", "/plain-frame#moved")`);
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    await tab.evaluate(`new Promise((resolve) => { const frame = document.getElementById("plain-frame"); frame.addEventListener("load", resolve, { once: true }); frame.src = "${partner}/card-frame"; })`);
    expect(await refusal(state, "click", "Show details")).toBe("STALE_REF");
    state = await snapshot();
    expect(state.elements.some((element) => element.frame)).toBe(false);
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(state.value.childFrames)[0]?.read).toBe(false);
    expect(await presses()).toEqual([]);
  });

  it("reports a page layer over a frame's control as covering the target", async () => {
    await open(`${shop}/covered`);
    const state = await snapshot();
    expect(state.value.blockers).toEqual([expect.objectContaining({ kind: "modal", covers: "target", ref: find(state, "Close").id })]);
  });

  it("finds a dialog in a frame and a consent layer in an open root, with the controls that close them", async () => {
    await open(`${shop}/framed-modal`);
    let state = await snapshot();
    expect(state.value.blockers).toEqual([expect.objectContaining({ kind: "modal", covers: "viewport", ref: find(state, "Close").id })]);
    await open(`${shop}/shadow-consent`);
    state = await snapshot();
    expect(state.value.blockers).toEqual([expect.objectContaining({ kind: "cookie-consent", rejectRef: find(state, "Reject all").id })]);
  });

  it("rings a shadow root's box and a bordered frame's box where they are, and scrolls a frame's box into view", async () => {
    for (const [url, label, locator] of [
      [`${shop}/signin`, "Username", () => tab.locator("#shadow-user")],
      [`${shop}/pay`, "Card number", () => tab.frameLocator("#card-frame").locator("#card")],
    ] as const) {
      await open(url);
      expect(await guide(await snapshot(), label)).toMatchObject({ accepted: true });
      await expect.poll(guided, { timeout: 5000 }).toBe(true);
      await near(await ring(), locator());
      await call(pageGuidance, [{ kind: "hide" }]);
    }
    await open(`${shop}/framed-plain`);
    await tab.evaluate(`(() => { const frame = document.getElementById("plain-frame"); frame.style.height = "80px"; frame.contentDocument.body.style.paddingTop = "400px"; })()`);
    const state = await snapshot();
    expect(find(state, "Email").inViewport).toBe(false);
    expect(await guide(state, "Email")).toMatchObject({ placement: "scrolled" });
    await expect.poll(guided, { timeout: 5000 }).toBe(true);
    await call(pageGuidance, [{ kind: "hide" }]);
  });

  it("drops a ring when its framed or shadow target changes", async () => {
    for (const [url, label, change] of [
      [`${shop}/framed-plain`, "Email", `document.getElementById("plain-frame").contentDocument.getElementById("email").placeholder = "changed"`],
      [`${shop}/signin`, "Username", `document.querySelector("northfield-login").shadowRoot.getElementById("shadow-user").placeholder = "changed"`],
    ] as const) {
      await open(url);
      expect(await guide(await snapshot(), label)).toMatchObject({ accepted: true });
      await expect.poll(guided, { timeout: 5000 }).toBe(true);
      await tab.evaluate(change);
      await expect.poll(guided, { timeout: 5000 }).toBe(false);
      expect(await evaluate("globalThis.__elizaPageGuidanceV1.invalidated"), url).toBe(true);
    }
  });

  it("reads a sign-in in a full-page frame's open root, refuses a fill there, and is not made stale by a hidden frame", async () => {
    await open(`${secure}/dashboard`);
    const state = await snapshot({ taskPolicy: policy("#none", "click", secure) });
    const user = find(state, "Username");
    expect(user).toMatchObject({ inShadowRoot: true, sensitive: null, frame: { index: 1, origin: secure, title: "logon" } });
    expect(find(state, "Password")).toMatchObject({ inShadowRoot: true, sensitive: "password" });
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(state.value.childFrames).map(({ bounds: _, ...frame }) => frame)).toEqual([
      { index: 1, read: true, origin: secure, parent: null, title: "logon" },
      { index: 2, read: false, reason: "not-rendered", origin: null, parent: null, title: "empty" },
    ]);
    expect(state.elements.filter((element) => element.label === "empty" || element.label === "Telemetry")).toEqual([]);
    expect(state.value.omitted).toContain("frames the page does not show (childFrames)");
    await tab.evaluate(`new Promise((resolve) => { const frame = document.querySelector('iframe[title="empty"]'); frame.contentDocument.body.append("ping"); frame.addEventListener("load", resolve, { once: true }); frame.contentWindow.location.assign("/empty?again"); })`);
    expect(await refusal(state, "fill", "Username", { text: "reader-id", taskPolicy: policy(selectorOf(user), "fill", secure) })).toBe("POLICY_BLOCKED");
    expect(await tab.frameLocator('iframe[name="logonbox"]').locator("#userId #input").inputValue()).toBe("");
  });

  it("through the browser host, presses a bound frame control once and never reads a partner origin's frame", async () => {
    await open(`${shop}/framed-plain`);
    const target = selectorOf(find(await snapshot(), "Show details"));
    const records: Fields = {};
    const handle = createCommandHandler({
      runtime: { id: "test-extension" },
      storage: { local: { get: (key: string) => Promise.resolve({ [key]: records[key] }), set: (values: Fields) => Promise.resolve(Object.assign(records, values)) } },
      tabs: { query: () => Promise.resolve([{ id: 1 }]), get: () => Promise.resolve({ url: tab.url(), status: "complete" }) },
      webNavigation: { getAllFrames: async () => (await frameList()).map(({ frameId, documentId }) => ({ frameId, documentId })) },
      scripting: {
        executeScript: async (request: { target: { frameIds?: number[]; allFrames?: boolean }; func: (...args: never[]) => unknown; args: unknown[] }) => {
          const chosen = (await frameList()).filter(({ frameId }) => request.target.allFrames === true || request.target.frameIds?.includes(frameId));
          return Promise.all(chosen.map(async ({ frameId, documentId, contextId }) => ({ frameId, documentId, result: await evaluate(`(${Function.prototype.toString.call(request.func)})(...${JSON.stringify(request.args)})`, await contextId()) })));
        },
      },
    });
    const send = async (message: Fields) => {
      let reply: unknown;
      await handle(message, { send: (value) => { reply = value; } }, () => true);
      return fields(reply);
    };
    const raw = Schema.decodeUnknownSync(Schema.Array(Fields))(fields((await send({ type: "command", id: "raw-1", command: { subaction: "snapshot", id: "1" } })).result).frames);
    expect(raw.map((read) => Schema.decodeUnknownSync(Schema.Array(Fields))(read.elements).filter((element) => element.label === "Show details").length)).toEqual([0, 1]);
    const taskContext = { actorId: "actor", accountId: "account", agentId: "agent", taskId: "task", epoch: 0 };
    expect(await send({
      type: "task-bind", id: "bind-1",
      binding: { ...taskContext, tabId: "1", bindingRevision: 1, origin: shop, origins: [shop, partner], expiresAt: Date.now() + 120_000, targets: [{ selector: target, action: "click" }], revoked: false },
    })).toMatchObject({ ok: true });
    const read = await send({ type: "command", id: "read-1", command: { subaction: "snapshot", id: "1", taskContext } });
    const top = fields(Schema.decodeUnknownSync(Schema.Array(Fields))(fields(read.result).frames)[0]);
    const button = fields(Schema.decodeUnknownSync(Schema.Array(Fields))(top.elements).find((element) => element.label === "Show details"));
    expect(text(button.selector)).toMatch(/^[0-9a-f-]{36}:0:\d+$/);
    expect(button.frame).toMatchObject({ origin: shop });
    expect(await send({ type: "command", id: "click-1", command: { subaction: "click", id: "1", selector: button.selector, expectedSelector: target, taskContext } })).toMatchObject({ ok: true });
    expect(await presses()).toEqual(["details"]);
    await open(`${shop}/pay`);
    const again = await send({ type: "command", id: "read-2", command: { subaction: "snapshot", id: "1", taskContext } });
    const frame = fields(Schema.decodeUnknownSync(Schema.Array(Fields))(fields(again.result).frames)[0]);
    expect(Schema.decodeUnknownSync(Schema.Array(Fields))(frame.childFrames).map((child) => child.read)).toEqual([true, false]);
    expect(text(frame.text)).not.toContain("Partner words");
  });
});
