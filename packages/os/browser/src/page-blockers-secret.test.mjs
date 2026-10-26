import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { pageCommand } from "./page-command.mjs";

const SECRET = "hunter2secretvalue";

// A sign-in wall whose text repeats the typed password across the 200-character cut.
function loadPage() {
  const lead = "Please sign in to continue ";
  const pad = "x".repeat(200 - lead.length - 10);
  const { window } = new JSDOM(
    `<body><main><form><input type="password" id="p"><p>${lead}${pad} ${SECRET}</p></form></main></body>`,
    { pretendToBeVisual: true, url: "https://example.com/" },
  );
  window.document.getElementById("p").value = SECRET;
  window.Element.prototype.checkVisibility = () => true;
  window.Element.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
  });
  window.document.elementFromPoint = () => null;
  for (const name of Object.getOwnPropertyNames(window))
    if (!(name in globalThis))
      try {
        globalThis[name] = window[name];
      } catch {}
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    getComputedStyle: window.getComputedStyle.bind(window),
    visualViewport: { scale: 1 },
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
    innerWidth: 1000,
    innerHeight: 800,
  });
  for (const name of ["Node", "Element", "NodeFilter", "HTMLElement"])
    globalThis[name] = window[name];
}

test("blocker text never carries part of a secret field's value", () => {
  loadPage();
  const { blockers } = pageCommand({ subaction: "snapshot" }, "s1");
  expect(blockers.length).toBeGreaterThan(0);
  for (const blocker of blockers) {
    expect(blocker.text.includes(SECRET.slice(0, 7))).toBe(false);
    expect(blocker.text.length).toBeLessThanOrEqual(200);
  }
});
