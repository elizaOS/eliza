// Preload for bun test: install a minimal jsdom DOM on globalThis.
// Loaded via `bun test --preload ./src/test-dom-setup.ts`.
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  "<!doctype html><html><head></head><body></body></html>",
  {
    url: "https://unit-test.local/",
    pretendToBeVisual: true,
  },
);

const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLAnchorElement: dom.window.HTMLAnchorElement,
  HTMLFormElement: dom.window.HTMLFormElement,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event,
  InputEvent: dom.window.InputEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};

for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}
