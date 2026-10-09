/** Actual isolated-world guidance DOM, not native host or Android acceptance. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { pageCommand } from "../src/commands.mjs";
import { pageGuidance } from "../src/page-guidance.mjs";

const require = createRequire(
  import.meta.resolve("@elizaos/plugin-browser/package.json"),
);
const { default: puppeteer } = require("puppeteer-core");
if (!process.env.ELIZA_BROWSER_EXECUTABLE)
  throw new Error("Set ELIZA_BROWSER_EXECUTABLE");
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/labels") {
    // A strict font policy must not block the overlay's bundled font bytes.
    res.setHeader("Content-Security-Policy", "font-src 'none'");
    res.end(
      '<!doctype html><style>body{margin:0;font:22px Arial}button,input{position:absolute;font:22px Arial;padding:16px}</style><button id="first" style="left:40px;top:40px">First step</button><input id="email" aria-label="Email" style="left:600px;top:40px"><button id="last" style="left:40px;top:520px">Last step</button><script>window.pageClicks=[];document.addEventListener("click",e=>window.pageClicks.push({target:e.target.nodeName,path:e.composedPath().map(n=>n.nodeName||"window")}),true)</script>',
    );
    return;
  }
  res.end(
    '<!doctype html><style>body{height:2400px;font:22px system-ui}button{margin:100px 20px;padding:20px}</style><button id="target">Continue on this website</button><input type="password" value="private-secret"><p>Provider content</p>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const cases = [];
try {
  browser = await puppeteer.launch({
    executablePath: process.env.ELIZA_BROWSER_EXECUTABLE,
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // Placement and invalidation cases use reduced motion: the guide appears in
  // place. Cursor travel and its timing are checked separately below.
  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const cdp = await page.createCDPSession();
  let executionContextId;
  const isolate = async () => {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    ({ executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "eliza-guidance-test",
    }));
  };
  await isolate();
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      r.exceptionDetails,
      undefined,
      JSON.stringify(r.exceptionDetails),
    );
    return r.result.value;
  };
  const call = (fn, ...args) =>
    evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  let sequence = 0;
  const offer = async (id = "step-1", extra = {}) => {
    const snapshotId = `guide-${++sequence}`;
    const snapshot = await call(
      pageCommand,
      { subaction: "snapshot" },
      snapshotId,
    );
    assert.ok(!JSON.stringify(snapshot).includes("private-secret"));
    assert.ok(!snapshot.text.includes("Use this control when you are ready."));
    assert.ok(!snapshot.elements.some((e) => e.label === "Dismiss guidance"));
    const target = snapshot.elements.find(
      (e) => e.label === "Continue on this website",
    );
    return call(pageGuidance, {
      kind: "show",
      id,
      origin,
      snapshotId,
      nodeId: target.id,
      text: "Use this control when you are ready.",
      expiresAt: Date.now() + 60000,
      ...extra,
    });
  };
  const state = () =>
    evaluate(
      `(()=>{const s=globalThis.__elizaPageGuidanceV1;const target=document.querySelector('#target').getBoundingClientRect();const label=s.shadow.querySelector('.label').getBoundingClientRect();return {visible:s.visible,dismissed:s.dismissed,target:{x:target.x,y:target.y,width:target.width,height:target.height},label:{x:label.x,y:label.y,width:label.width,height:label.height}}})()`,
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const original = await page.$eval("#target", (node) => ({
    style: node.getAttribute("style"),
    text: node.textContent,
  }));
  assert.equal((await offer()).accepted, true);
  await settle();
  assert.equal(
    await evaluate(
      "globalThis.__elizaBrowserControlV1.domRevision === globalThis.__elizaBrowserObservationV1.domRevision",
    ),
    true,
  );
  await call(pageGuidance, { kind: "hide" });
  await settle();
  assert.equal(
    await evaluate(
      "globalThis.__elizaBrowserControlV1.domRevision === globalThis.__elizaBrowserObservationV1.domRevision",
    ),
    true,
  );
  await page.evaluate(() =>
    document.documentElement.append(document.createElement("div")),
  );
  await settle();
  assert.equal(
    await evaluate(
      "globalThis.__elizaBrowserControlV1.domRevision < globalThis.__elizaBrowserObservationV1.domRevision",
    ),
    true,
  );
  await offer();
  await settle();
  cases.push(
    "only trusted guide mount/removal is excluded from DOM revisions; provider insertion invalidates",
  );
  const s = await state();
  assert.equal(s.visible, true);
  assert.equal(
    await evaluate(
      'getComputedStyle(globalThis.__elizaPageGuidanceV1.shadow.querySelector(".label")).fontSize',
    ),
    "20px",
  );
  assert.ok(
    s.label.y >= s.target.y + s.target.height ||
      s.label.y + s.label.height <= s.target.y ||
      s.label.x >= s.target.x + s.target.width ||
      s.label.x + s.label.width <= s.target.x,
  );
  assert.deepEqual(
    await page.$eval("#target", (node) => ({
      style: node.getAttribute("style"),
      text: node.textContent,
    })),
    original,
  );
  assert.equal(
    await page.evaluate(() => globalThis.__elizaPageGuidanceV1),
    undefined,
  );
  cases.push("isolated annotation does not restyle provider or cover target");
  await evaluate(
    "globalThis.__elizaPageGuidanceV1.shadow.querySelector('.close').click()",
  );
  assert.equal((await state()).visible, false);
  assert.equal((await offer()).dismissed, true);
  await settle();
  assert.equal((await state()).visible, false);
  await offer("step-1", { restore: true });
  await settle();
  assert.equal((await state()).visible, true);
  cases.push(
    "same-step dismissal persists across fresh offers; explicit restore works",
  );
  await page.evaluate(() => scrollTo(0, 700));
  await settle();
  assert.equal((await state()).visible, false);
  await page.evaluate(() => scrollTo(0, 0));
  await settle();
  assert.equal((await state()).visible, true);
  await page.setViewport({ width: 640, height: 960 });
  await settle();
  assert.equal((await state()).visible, true);
  cases.push("scroll and viewport resize re-anchor only after stable geometry");
  await page.$eval("#target", (node) => (node.style.marginTop = "180px"));
  await settle();
  assert.equal((await state()).visible, false);
  await offer();
  await settle();
  assert.equal((await state()).visible, true);
  cases.push("DOM movement requires a fresh observation");
  await page.$eval("input", (node) =>
    node.dispatchEvent(new InputEvent("beforeinput", { bubbles: true })),
  );
  await settle();
  assert.equal((await state()).visible, false);
  await offer("manual-next");
  await settle();
  assert.equal((await state()).visible, true);
  await evaluate(
    "globalThis.__elizaPageGuidanceV1.shadow.querySelector('.close').click()",
  );
  await offer("genuinely-new-step");
  await settle();
  assert.equal((await state()).visible, true);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.25 });
  await settle();
  const zoomed = await state();
  if (zoomed.visible)
    assert.ok(
      zoomed.label.y >= zoomed.target.y + zoomed.target.height ||
        zoomed.label.y + zoomed.label.height <= zoomed.target.y ||
        zoomed.label.x >= zoomed.target.x + zoomed.target.width ||
        zoomed.label.x + zoomed.label.width <= zoomed.target.x,
    );
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await settle();
  cases.push(
    "manual input hides guidance; new step restores; zoom never overlaps target",
  );
  const output = testOutputPath("page-guidance");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/narrow.png` });
  await page.setViewport({ width: 1280, height: 800 });
  await settle();
  await page.screenshot({ path: `${output}/desktop.png` });
  await offer("expiry", { expiresAt: Date.now() + 300 });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal((await state()).visible, false);
  assert.equal(
    (await offer("wrong-origin", { origin: "https://other.example" })).reason,
    "invalid-context",
  );
  await offer("hide");
  await settle();
  await call(pageGuidance, { kind: "hide" });
  assert.equal((await state()).visible, false);
  cases.push("expiry, origin mismatch and host hide remove guidance");
  // A landscape IME leaves room beside the field, but neither above nor
  // below it. Side placement must shift vertically inside the visible area.
  await page.setViewport({ width: 1280, height: 220 });
  await page.$eval("#target", (node) => {
    node.style.cssText =
      "position:fixed;left:34px;top:88px;width:295px;height:44px;margin:0;padding:0";
  });
  await offer("short-viewport", {
    text: "Synthetic guidance: this is the nickname field.",
  });
  await settle();
  const short = await state();
  assert.equal(
    short.visible,
    true,
    "A guide with room beside the field must remain visible",
  );
  assert.ok(short.label.y >= 8 && short.label.y + short.label.height <= 212);
  assert.ok(
    short.label.x >= short.target.x + short.target.width + 8 ||
      short.label.x + short.label.width <= short.target.x - 8,
  );
  await page.screenshot({ path: `${output}/short-viewport.png` });
  cases.push(
    "IME-sized viewport uses available side space without covering the field",
  );
  // ---- Labels, offers, answers, cursor travel, pause and font -------------
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${origin}/labels`);
  await isolate();
  const { guideFonts } = await import("../src/guide-font.mjs");
  const read = async (snapshotId) => {
    const snapshot = await call(
      pageCommand,
      { subaction: "snapshot" },
      snapshotId,
    );
    return (label) => {
      const found = snapshot.elements.find((e) => e.label === label);
      assert.ok(found, JSON.stringify(snapshot.elements.map((e) => e.label)));
      return found.id;
    };
  };
  const show = async (snapshotId, node, extra = {}) =>
    call(pageGuidance, {
      kind: "show",
      id: "labels",
      origin,
      snapshotId,
      nodeId: node,
      text: "Type your email here.",
      expiresAt: Date.now() + 60000,
      assistantName: "Grace",
      fonts: guideFonts,
      ...extra,
    });
  const part = (selector, expression) =>
    evaluate(
      `(()=>{const n=globalThis.__elizaPageGuidanceV1.shadow.querySelector(${JSON.stringify(selector)});return n&&(${expression})})()`,
    );
  const until = async (expression, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (!(await evaluate(expression))) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const shown =
    "globalThis.__elizaPageGuidanceV1?.visible && globalThis.__elizaPageGuidanceV1.shadow.querySelector('.label').classList.contains('shown')";
  // Grace sheet sequence: travel 1.4s, tap ring 700ms, cursor hides, ring,
  // then the label 250ms later. Sampled every frame inside the isolated realm.
  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "no-preference" },
  ]);
  let element = await read("labels-1");
  await evaluate(
    "globalThis.__elizaGuideCursorV1 = { point: [1000, 600] }; true",
  );
  assert.equal((await show("labels-1", element("Email"))).accepted, true);
  await evaluate(
    `(()=>{const samples=globalThis.__samples=[];const t0=performance.now();const tick=()=>{const s=globalThis.__elizaPageGuidanceV1;const q=(c)=>s.shadow.querySelector(c);const p=q('.pointer');const r=p.getBoundingClientRect();samples.push({t:performance.now()-t0,pointer:p.style.display==='block',tapping:p.classList.contains('tapping'),x:r.left,y:r.top,ring:!q('.ring').hidden,label:!q('.label').hidden,shown:q('.label').classList.contains('shown'),opacity:getComputedStyle(q('.label')).opacity});if(samples.length<400)requestAnimationFrame(tick)};requestAnimationFrame(tick);return true})()`,
  );
  await until(shown);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const samples = await evaluate("globalThis.__samples");
  const first = (test) => samples.find(test)?.t;
  const travelStart = first((x) => x.pointer);
  const tapStart = first((x) => x.tapping);
  const ringStart = first((x) => x.ring);
  const labelShown = first((x) => x.shown);
  assert.ok(Math.abs(samples.find((x) => x.pointer).x - 997) < 2);
  assert.ok(tapStart - travelStart >= 1350 && tapStart - travelStart < 1600);
  assert.ok(ringStart - tapStart >= 650 && ringStart - tapStart < 900);
  assert.ok(
    samples.filter((x) => x.ring || x.label).every((x) => !x.pointer),
    "the cursor hides before the ring and label appear",
  );
  assert.ok(labelShown - ringStart >= 230 && labelShown - ringStart < 400);
  assert.ok(samples.filter((x) => x.t < ringStart).every((x) => !x.label));
  assert.equal(
    await part(".pointer", "getComputedStyle(n).transitionTimingFunction"),
    "cubic-bezier(0.45, 0, 0.25, 1), cubic-bezier(0.45, 0, 0.25, 1)",
  );
  assert.equal(
    await part(".ring", "getComputedStyle(n).animationIterationCount"),
    "3",
  );
  assert.equal(await part(".label", "getComputedStyle(n).opacity"), "1");
  cases.push(
    "cursor travels 1.4s from where last seen, taps 700ms, hides; ring then label 250ms later",
  );
  // Grace computed styles, configured name and the bundled font.
  await until(
    "globalThis.__elizaPageGuidanceV1.shadow.querySelector('.ring').getAnimations().length === 0",
  );
  assert.deepEqual(
    await evaluate(
      `(()=>{const s=globalThis.__elizaPageGuidanceV1.shadow;const css=(c)=>getComputedStyle(s.querySelector(c));return {ring:css('.ring').boxShadow,label:[css('.label').borderTopColor,css('.label').borderTopWidth,css('.label').borderTopLeftRadius,css('.label').paddingTop],title:[css('.title').fontSize,css('.title').fontWeight,css('.title').lineHeight],mark:[s.querySelector('.mark').textContent,css('.mark').width,css('.mark').backgroundColor],tag:s.querySelector('.tag').textContent,close:[css('.close').height,css('.close').borderTopLeftRadius],family:css('.title').fontFamily.startsWith('eliza-guide-'),loaded:[...document.fonts].filter(f=>f.family.startsWith('eliza-guide-')).map(f=>f.status+':'+f.weight)}})()`,
    ),
    {
      ring: "rgb(255, 255, 255) 0px 0px 0px 3px, rgb(74, 52, 40) 0px 0px 0px 6px",
      label: ["rgb(179, 170, 211)", "2px", "16px", "18px"],
      title: ["22px", "700", "28px"],
      mark: ["G", "34px", "rgb(212, 206, 234)"],
      tag: "GGrace",
      close: ["64px", "20px"],
      family: true,
      loaded: ["loaded:500", "loaded:700"],
    },
  );
  assert.equal(
    await page.evaluate(() =>
      [...document.fonts].some((f) => f.family.startsWith("eliza-guide-")),
    ),
    true,
    "the bundled font is added from bytes despite the page's font-src 'none'",
  );
  cases.push(
    "Grace ring, label, mark and close styles; configured name; bundled Figtree loads under page CSP",
  );
  // The same step's later revision changes tone in place: no travel or slide.
  assert.equal(
    (
      await show("labels-1", element("Email"), {
        text: "Filled in your email.",
        detail: "Check it before you continue.",
        tone: "success",
      })
    ).accepted,
    true,
  );
  await until("globalThis.__elizaPageGuidanceV1?.visible");
  assert.equal(await part(".pointer", "n.style.display"), "none");
  assert.equal(await part(".label", "n.classList.contains('shown')"), true);
  assert.deepEqual(
    await evaluate(
      `(()=>{const s=globalThis.__elizaPageGuidanceV1.shadow;const css=(c)=>getComputedStyle(s.querySelector(c));return [css('.label').borderTopColor,s.querySelector('.mark').textContent,css('.mark').backgroundColor,s.querySelector('.detail').textContent,css('.detail').fontSize,css('.detail').fontWeight]})()`,
    ),
    [
      "rgb(38, 91, 25)",
      "✓",
      "rgb(38, 91, 25)",
      "Check it before you continue.",
      "17px",
      "500",
    ],
  );
  await page.screenshot({ path: `${output}/success.png` });
  cases.push("success tone and detail line replace the same step in place");
  // Offers: value cards and Yes / I'll type it. Values stay in the closed tree.
  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  await evaluate(
    "globalThis.chrome={runtime:{sendMessage:async(m)=>{(globalThis.__sent??=[]).push(m);return {delivered:true}}}};true",
  );
  const privateValues = ["margaret@example.test", "m.hale@example.test"];
  await page.evaluate(() => {
    const cover = document.createElement("div");
    cover.id = "cover";
    cover.popover = "manual";
    cover.style.cssText =
      "inset:0;width:100vw;height:100vh;margin:0;border:0;background:#fff8;pointer-events:none";
    cover.textContent = "Fake label";
    document.body.append(cover);
  });
  element = await read("labels-2");
  await show("labels-2", element("Email"), {
    id: "offer",
    text: "Which email should I use?",
    tone: "offer",
    answerKey: "answer-key-1",
    answers: [
      { id: "card-0", kind: "card", text: privateValues[0], tag: "Personal" },
      { id: "card-1", kind: "card", text: privateValues[1], tag: "Work" },
      { id: "type", kind: "secondary", text: "I'll type it" },
    ],
  });
  await until(shown);
  const center = (selector) =>
    part(
      selector,
      "(()=>{const r=n.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()",
    );
  // A tap within 800ms of the label appearing is ignored (clickjacking guard).
  await page.mouse.click(...(await center(".card")));
  await page.screenshot({ path: `${output}/offer-cards.png` });
  assert.deepEqual(
    await evaluate(
      `(()=>{const s=globalThis.__elizaPageGuidanceV1.shadow;const css=(n)=>getComputedStyle(n);const card=s.querySelector('.card');return {cards:s.querySelectorAll('.card').length,value:[css(card.querySelector('.value')).fontSize,css(card.querySelector('.value')).fontWeight],purpose:[css(card.querySelector('.purpose')).fontSize,css(card.querySelector('.purpose')).fontWeight],card:card.getBoundingClientRect().height>=64,secondary:[css(s.querySelector('.secondary')).height,css(s.querySelector('.secondary')).boxShadow],close:!!s.querySelector('.close')}})()`,
    ),
    {
      cards: 2,
      value: ["22px", "700"],
      purpose: ["17px", "500"],
      card: true,
      secondary: ["64px", "rgba(74, 52, 40, 0.6) 0px 0px 0px 1.5px inset"],
      close: false,
    },
  );
  const pageView = await page.evaluate(() => {
    const host = [...document.documentElement.children].at(-1);
    return {
      html: document.documentElement.outerHTML,
      text: document.body.innerText,
      attributes: host.getAttributeNames(),
      shadow: host.shadowRoot,
    };
  });
  for (const value of privateValues) {
    assert.ok(!pageView.html.includes(value));
    assert.ok(!pageView.text.includes(value));
  }
  assert.deepEqual(pageView.attributes, ["style"]);
  assert.equal(pageView.shadow, null);
  const observed = await call(
    pageCommand,
    { subaction: "snapshot" },
    "labels-3",
  );
  for (const value of privateValues)
    assert.ok(!JSON.stringify(observed).includes(value));
  cases.push(
    "offer cards and decline render 22/700 values, 17/500 tags, 64px buttons; values never reach page DOM, attributes or snapshot",
  );
  // Script clicks are not trusted taps.
  await part(".card", "(n.click(),true)");
  assert.equal(await evaluate("(globalThis.__sent??[]).length"), 0);
  await new Promise((resolve) => setTimeout(resolve, 850));
  // A page top-layer element drawn over the label, even one that lets taps
  // through, blocks answers until it is gone. Opening a popover changes no DOM.
  await page.evaluate(() => document.querySelector("#cover").showPopover());
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.mouse.click(...(await center(".card")));
  assert.equal(await evaluate("(globalThis.__sent??[]).length"), 0);
  await page.evaluate(() => document.querySelector("#cover").hidePopover());
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.mouse.click(...(await center(".card:nth-child(2)")));
  assert.equal(await evaluate("(globalThis.__sent??[]).length"), 0);
  await new Promise((resolve) => setTimeout(resolve, 850));
  await page.mouse.click(...(await center(".card:nth-child(2)")));
  await page.mouse.click(...(await center(".secondary")));
  const sent = await evaluate("globalThis.__sent");
  assert.deepEqual(sent, [
    {
      type: "task-guide-answer",
      guideId: "offer",
      answerKey: "answer-key-1",
      answerId: "card-1",
    },
  ]);
  const clicks = await page.evaluate(() => window.pageClicks);
  assert.ok(clicks.length >= 2);
  for (const click of clicks) {
    assert.equal(click.target, "DIV");
    assert.ok(!click.path.includes("BUTTON"));
  }
  assert.ok(!JSON.stringify(clicks).includes("example.test"));
  cases.push(
    "one trusted tap sends only the answer ID once; script clicks, early taps, covered labels and repeats send nothing; page sees only the host",
  );
  // Pause: ring, label and answers leave; the grey cursor stays.
  element = await read("labels-4");
  await show("labels-4", element("Last step"), {
    id: "action-preview",
    action: "click",
  });
  await until("globalThis.__elizaPageGuidanceV1?.visible");
  const jumped = await part(
    ".pointer",
    "[n.style.display,getComputedStyle(n).transitionDuration,n.getBoundingClientRect().left]",
  );
  assert.equal(jumped[0], "block");
  assert.equal(jumped[1], "0s");
  cases.push("reduced motion: the action cursor jumps to its target");
  assert.deepEqual(await call(pageGuidance, { kind: "pause" }), {
    visible: false,
    paused: true,
  });
  assert.deepEqual(
    await evaluate(
      `(()=>{const s=globalThis.__elizaPageGuidanceV1;const q=(c)=>s.shadow.querySelector(c);return {paused:s.paused,ring:q('.ring').hidden,label:q('.label').hidden,pointer:q('.pointer').style.display,left:q('.pointer').getBoundingClientRect().left,tag:q('.tag').textContent,tagColor:getComputedStyle(q('.tag')).backgroundColor,arrow:getComputedStyle(q('svg')).fill}})()`,
    ),
    {
      paused: true,
      ring: true,
      label: true,
      pointer: "block",
      left: jumped[2],
      tag: "GGrace · paused",
      tagColor: "rgb(74, 74, 71)",
      arrow: "rgb(115, 114, 108)",
    },
  );
  assert.deepEqual(
    await call(pageGuidance, {
      kind: "action-status",
      id: "action-preview",
      snapshotId: "labels-4",
      nodeId: element("Last step"),
      action: "click",
    }),
    { ready: false, cancelled: true },
  );
  await page.screenshot({ path: `${output}/paused.png` });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(
    await evaluate("globalThis.__elizaPageGuidanceV1.visible"),
    false,
  );
  await call(pageGuidance, { kind: "hide" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.lastElementChild.tagName,
    ),
    "BODY",
  );
  cases.push(
    "pause leaves a grey '<name> · paused' cursor where last seen and cancels a pending action",
  );
  // A page face that claims the overlay family switches it to the system font.
  element = await read("labels-5");
  await show("labels-5", element("First step"));
  await until(shown);
  await page.evaluate(() => {
    const ours = [...document.fonts].find((f) =>
      f.family.startsWith("eliza-guide-"),
    );
    document.fonts.add(new FontFace(ours.family, "local(Arial)"));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await part(".title", "getComputedStyle(n).fontFamily"),
    "system-ui, sans-serif",
  );
  await call(pageGuidance, { kind: "hide" });
  cases.push("a page font claiming the overlay family is refused");
  await writeFile(
    `${output}/verification.json`,
    JSON.stringify(
      {
        cases,
        browser: await browser.version(),
        scope:
          "actual Chromium DOM and isolated realm; host integration and Android unverified",
      },
      null,
      2,
    ),
  );
  console.log(`PASS page guidance: ${cases.join("; ")}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
