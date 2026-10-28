import assert from "node:assert/strict";
import test from "node:test";
import { blockerSelectors, pageCommand } from "./page-command.mjs";

test("blocker refs become the snapshot's own element selectors", () => {
  assert.deepEqual(
    blockerSelectors(
      [
        { kind: "modal", ref: "3", covers: "viewport", text: "Get our news" },
        { kind: "cookie-consent", rejectRef: "7", covers: "target" },
        { kind: "captcha", covers: "partial" },
      ],
      "snap:0",
    ),
    [
      {
        kind: "modal",
        ref: "snap:0:3",
        covers: "viewport",
        text: "Get our news",
      },
      { kind: "cookie-consent", rejectRef: "snap:0:7", covers: "target" },
      { kind: "captcha", covers: "partial" },
    ],
  );
});

test("a page from a browser without blocker reports has none", () => {
  assert.deepEqual(blockerSelectors(undefined, "snap:0"), []);
});

test("the in-page snapshot reports blockers and never presses a control", () => {
  // pageCommand runs as source text in the page; its blocker pass may only
  // read the page. It must not click, submit or focus anything it finds.
  const source = pageCommand.toString();
  const start = source.indexOf("const blockers = (() => {");
  const end = source.indexOf("globalThis[key] = {", start);
  assert.ok(start > 0 && end > start);
  const pass = source.slice(start, end);
  for (const effect of [".click(", ".submit(", ".focus(", "dispatchEvent("])
    assert.equal(pass.includes(effect), false, effect);
  assert.ok(source.includes("blockers,"));
});
