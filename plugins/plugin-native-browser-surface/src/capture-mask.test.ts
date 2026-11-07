/** Executes the bundled capture mask against a DOM with controlled layout: secret fields and unreadable frames are covered before a screenshot, and nothing is captured when a cover cannot be placed. */
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../resources/capture-mask.js"),
  "utf8",
);
const run = (command: unknown) =>
  runInNewContext(`${source}; captureMask(${JSON.stringify(command)})`, {
    document,
    getComputedStyle,
    Math,
  }) as Record<string, unknown>;

/** Page elements report a fixed layout; covers report the box they were given. */
function layout(rects: Map<Element, DOMRect>) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const known = rects.get(this);
      if (known) return known;
      if (this instanceof HTMLElement && this.style.left) {
        const px = (value: string) => Number.parseFloat(value);
        return new DOMRect(
          px(this.style.left),
          px(this.style.top),
          px(this.style.width),
          px(this.style.height),
        );
      }
      return new DOMRect(0, 0, 0, 0);
    },
  );
}

afterEach(() => {
  document.body.replaceChildren();
  for (const box of document.querySelectorAll("[data-eliza-capture-mask]"))
    box.remove();
  vi.restoreAllMocks();
});

it("covers passwords, card fields, one-time codes and unreadable frames, then removes every cover", () => {
  const field = (attributes: Record<string, string>) => {
    const input = document.createElement("input");
    for (const [name, value] of Object.entries(attributes))
      input.setAttribute(name, value);
    input.value = "4111 1111 1111 1111";
    document.body.append(input);
    return input;
  };
  const password = field({ type: "password" });
  const card = field({ autocomplete: "cc-number" });
  const code = field({ autocomplete: "one-time-code" });
  const name = field({ autocomplete: "name" });
  const frame = document.createElement("iframe");
  document.body.append(frame);
  Object.defineProperty(frame, "contentDocument", { get: () => null });
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const hidden = document.createElement("input");
  hidden.setAttribute("autocomplete", "cc-csc");
  shadow.append(hidden);
  layout(
    new Map<Element, DOMRect>([
      [password, new DOMRect(10, 20, 200, 30)],
      [card, new DOMRect(10, 60, 200, 30)],
      [code, new DOMRect(10, 100, 120, 30)],
      [name, new DOMRect(10, 140, 200, 30)],
      [frame, new DOMRect(10, 180, 300, 60)],
      [hidden, new DOMRect(220, 60, 60, 30)],
    ]),
  );
  const masked = run({ action: "mask", token: "t1" });
  expect(masked).toEqual({ fields: 4, frames: 1, boxes: 5 });
  const covers = [...document.querySelectorAll("[data-eliza-capture-mask]")];
  expect(covers).toHaveLength(5);
  expect(
    covers.map((box) => (box as HTMLElement).style.top).sort(),
  ).not.toContain("140px");
  expect(JSON.stringify(masked)).not.toContain("4111");
  expect(run({ action: "restore", token: "t1" })).toEqual({ removed: 5 });
  expect(document.querySelectorAll("[data-eliza-capture-mask]")).toHaveLength(
    0,
  );
});

it("covers host-classified secrets and leaves readable frames to their own fields", () => {
  const amount = document.createElement("span");
  amount.className = "account-number";
  document.body.append(amount);
  layout(new Map<Element, DOMRect>([[amount, new DOMRect(5, 5, 80, 20)]]));
  expect(
    run({ action: "mask", token: "t2", selectors: [".account-number"] }),
  ).toEqual({ fields: 1, frames: 0, boxes: 1 });
  expect(
    run({ action: "mask", token: "t3", selectors: ["::not a selector"] }),
  ).toEqual({ error: "A capture mask selector is invalid." });
});

it("fails instead of capturing when a page style moves a cover", () => {
  const password = document.createElement("input");
  password.type = "password";
  document.body.append(password);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return this === password
        ? new DOMRect(10, 20, 200, 30)
        : new DOMRect(0, 0, 1, 1);
    },
  );
  expect(run({ action: "mask", token: "t4" })).toEqual({
    error: "A capture mask could not cover a secret field.",
  });
  expect(document.querySelectorAll("[data-eliza-capture-mask]")).toHaveLength(
    0,
  );
  expect(run({ action: "mask" })).toEqual({
    error: "A capture mask needs a token.",
  });
});
