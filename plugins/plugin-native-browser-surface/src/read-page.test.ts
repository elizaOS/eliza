/** Executes the bundled native read operation against a DOM with controlled layout, preserving complete visible text without exposing hidden form data. */
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../resources/read-page.js"),
  "utf8",
);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("reads beyond the former character and node limits without returning a partial payload", () => {
  const rects = Object.assign([new DOMRect(0, 0, 100, 20)], {
    item(index: number) {
      return this[index] ?? null;
    },
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(rects);
  const longText = `${"unabridged text ".repeat(2000)}終端 Ω`;
  const paragraph = document.createElement("p");
  paragraph.append(document.createTextNode(longText));
  const lines = [longText];
  for (let i = 0; i < 10_002; i++) {
    const text = `visible-${i}`;
    paragraph.append(document.createTextNode(text));
    lines.push(text);
  }
  document.body.append(paragraph);
  const hidden = document.createElement("div");
  hidden.hidden = true;
  hidden.textContent = "hidden secret";
  const input = document.createElement("input");
  input.value = "private form value";
  document.body.append(hidden, input);
  const result: unknown = runInNewContext(`${source}; readPage("body")`, {
    document,
    NodeFilter,
    getComputedStyle,
    location,
    Error,
  });
  expect(result).toMatchObject({ text: lines.join("\n"), truncated: false });
});

describe("display:contents", () => {
  // A browser gives a display:contents element no box, so it has no client
  // rects, while its text renders in the nearest ancestor box.
  const read = (selector: string): unknown => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      function (this: HTMLElement) {
        const rects =
          getComputedStyle(this).display === "contents"
            ? []
            : [new DOMRect(0, 0, 100, 20)];
        return Object.assign(rects, {
          item(index: number) {
            return rects[index] ?? null;
          },
        }) as unknown as DOMRectList;
      },
    );
    return runInNewContext(`${source}; readPage(${JSON.stringify(selector)})`, {
      document,
      NodeFilter,
      getComputedStyle,
      location,
      Error,
    });
  };
  const contents = (text: string) => {
    const element = document.createElement("span");
    element.style.display = "contents";
    element.textContent = text;
    return element;
  };

  it("reads text whose parent element is display:contents", () => {
    const paragraph = document.createElement("p");
    paragraph.append("Order total:", contents("$42.00 due today"));
    document.body.append(paragraph);
    expect(read("body")).toMatchObject({
      text: "Order total:\n$42.00 due today",
      truncated: false,
    });
  });

  it("reads a selected display:contents element through its ancestor box", () => {
    const summary = contents("Delivery Tuesday");
    summary.id = "summary";
    const nested = contents("Tracking 1Z999");
    summary.append(nested);
    document.body.append(summary);
    expect(read("#summary")).toMatchObject({
      text: "Delivery Tuesday\nTracking 1Z999",
      truncated: false,
    });
  });

  it("still drops display:contents text inside a hidden ancestor", () => {
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    hidden.append(contents("hidden total"));
    document.body.append(hidden, "shown");
    expect(read("body")).toMatchObject({ text: "shown", truncated: false });
  });
});
