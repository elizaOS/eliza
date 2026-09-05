/**
 * Pure helpers behind the workspace browser's form and navigation actions:
 * the two element type-guards, the control-value writer, the tab-state
 * projection, and the history stack.
 *
 * None of them were referenced by any test in the plugin. The history stack in
 * particular implements the forward-truncation rule every browser has, and a
 * projection that leaked a runtime field into serialized tab state would carry
 * a live JSDOM handle with it.
 *
 * Real jsdom, no mocks — it is already a direct dependency of this plugin.
 */

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cloneWebBrowserWorkspaceTabState,
  ensureBrowserWorkspaceCheckboxElement,
  ensureBrowserWorkspaceFormControlElement,
  pushWebBrowserWorkspaceHistory,
  setBrowserWorkspaceControlValue,
} from "./browser-workspace-forms";
import type { WebBrowserWorkspaceTabState } from "./browser-workspace-types";

let document: Document;

beforeEach(() => {
  document = new JSDOM("<!doctype html><body></body>").window.document;
});

function element(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  const child = host.firstElementChild;
  if (!child) throw new Error("fixture produced no element");
  return child;
}

describe("ensureBrowserWorkspaceFormControlElement", () => {
  it("accepts the three control tags", () => {
    for (const html of [
      "<input>",
      "<textarea></textarea>",
      "<select><option>a</option></select>",
    ]) {
      expect(() =>
        ensureBrowserWorkspaceFormControlElement(element(html), "fill"),
      ).not.toThrow();
    }
  });

  it("returns the SAME element, not a copy", () => {
    const input = element("<input>");
    expect(ensureBrowserWorkspaceFormControlElement(input, "type")).toBe(input);
  });

  it("refuses anything else, naming the subaction that asked", () => {
    for (const html of [
      "<div></div>",
      "<button></button>",
      "<span contenteditable></span>",
      "<form></form>",
      "<label></label>",
    ]) {
      expect(() =>
        ensureBrowserWorkspaceFormControlElement(element(html), "select"),
      ).toThrow(
        /workspace select requires an input, textarea, or select target/,
      );
    }
  });

  it("reports whichever subaction was passed", () => {
    for (const subaction of [
      "clipboard",
      "fill",
      "keyboardinserttext",
      "keyboardtype",
      "select",
      "type",
    ] as const) {
      expect(() =>
        ensureBrowserWorkspaceFormControlElement(
          element("<div></div>"),
          subaction,
        ),
      ).toThrow(new RegExp(`workspace ${subaction} requires`));
    }
  });
});

describe("ensureBrowserWorkspaceCheckboxElement", () => {
  it("accepts a checkbox and a radio", () => {
    for (const html of ['<input type="checkbox">', '<input type="radio">']) {
      expect(() =>
        ensureBrowserWorkspaceCheckboxElement(element(html), "check"),
      ).not.toThrow();
    }
  });

  it("accepts an uppercase type attribute", () => {
    // The DOM's `.type` getter lowercases a recognised keyword, so the guard
    // sees "checkbox" regardless of how the author wrote it.
    for (const html of ['<input type="CHECKBOX">', '<input type="Radio">']) {
      expect(() =>
        ensureBrowserWorkspaceCheckboxElement(element(html), "uncheck"),
      ).not.toThrow();
    }
  });

  it("refuses a padded type attribute, because the DOM resolves it to text", () => {
    // `type=" radio "` is not a recognised keyword, so `.type` reports "text"
    // and the element genuinely is a text input — refusing is correct. The
    // guard's own trim()/toLowerCase() therefore never changes the outcome for
    // a real DOM; it only guards a hand-rolled element-like object.
    const input = element('<input type=" radio ">') as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(() =>
      ensureBrowserWorkspaceCheckboxElement(input, "uncheck"),
    ).toThrow(/requires a checkbox or radio input target/);
  });

  it("refuses an input that is not checkable", () => {
    // A text input has a `.checked` property that silently accepts writes and
    // does nothing, so a loose guard here fails invisibly at runtime.
    for (const html of [
      "<input>",
      '<input type="text">',
      '<input type="submit">',
      '<input type="hidden">',
    ]) {
      expect(() =>
        ensureBrowserWorkspaceCheckboxElement(element(html), "check"),
      ).toThrow(/requires a checkbox or radio input target/);
    }
  });

  it("refuses non-input tags even when they look checkable", () => {
    for (const html of [
      '<div type="checkbox"></div>',
      '<select type="checkbox"></select>',
      '<button type="checkbox"></button>',
    ]) {
      expect(() =>
        ensureBrowserWorkspaceCheckboxElement(element(html), "check"),
      ).toThrow(/requires a checkbox or radio input target/);
    }
  });
});

describe("setBrowserWorkspaceControlValue", () => {
  it("sets the live value AND the attribute so serialized HTML agrees", () => {
    // `.value` alone is invisible to outerHTML, so a page snapshot or a
    // re-parse would lose whatever the agent typed.
    const input = element("<input>") as HTMLInputElement;
    setBrowserWorkspaceControlValue(input, "typed");
    expect(input.value).toBe("typed");
    expect(input.getAttribute("value")).toBe("typed");
  });

  it("also mirrors into textContent for a textarea", () => {
    // A textarea's serialized content is its text node, not a value attribute.
    const area = element("<textarea>old</textarea>") as HTMLTextAreaElement;
    setBrowserWorkspaceControlValue(area, "new");
    expect(area.value).toBe("new");
    expect(area.textContent).toBe("new");
  });

  it("does NOT write textContent for a non-textarea", () => {
    const select = element(
      "<select><option value='a'>a</option><option value='b'>b</option></select>",
    ) as HTMLSelectElement;
    const before = select.textContent;
    setBrowserWorkspaceControlValue(select, "b");
    expect(select.value).toBe("b");
    expect(select.textContent).toBe(before);
  });

  it("clears cleanly with an empty string", () => {
    const input = element('<input value="old">') as HTMLInputElement;
    setBrowserWorkspaceControlValue(input, "");
    expect(input.value).toBe("");
    expect(input.getAttribute("value")).toBe("");
  });
});

describe("cloneWebBrowserWorkspaceTabState", () => {
  function tabState(): WebBrowserWorkspaceTabState {
    return {
      id: "tab-1",
      title: "Example",
      url: "https://example.com/",
      partition: "default",
      kind: "web",
      visible: true,
      createdAt: 1,
      updatedAt: 2,
      lastFocusedAt: 3,
      // Runtime-only fields that must never reach serialized tab state.
      dom: { window: {} },
      history: ["https://example.com/"],
      historyIndex: 0,
      loadedUrl: "https://example.com/",
    } as unknown as WebBrowserWorkspaceTabState;
  }

  it("projects exactly the serializable fields", () => {
    expect(
      Object.keys(cloneWebBrowserWorkspaceTabState(tabState())).sort(),
    ).toEqual([
      "createdAt",
      "id",
      "kind",
      "lastFocusedAt",
      "partition",
      "title",
      "updatedAt",
      "url",
      "visible",
    ]);
  });

  it("carries no runtime handle into the clone", () => {
    // `dom` holds a live JSDOM window. Leaking it would make tab state
    // unserializable and pin the whole document in memory.
    const clone = cloneWebBrowserWorkspaceTabState(tabState()) as Record<
      string,
      unknown
    >;
    for (const key of ["dom", "history", "historyIndex", "loadedUrl"]) {
      expect(clone).not.toHaveProperty(key);
    }
    expect(() => JSON.stringify(clone)).not.toThrow();
  });

  it("is a detached copy: mutating it does not touch the source", () => {
    const source = tabState();
    const clone = cloneWebBrowserWorkspaceTabState(source);
    clone.title = "changed";
    expect(source.title).toBe("Example");
  });
});

describe("pushWebBrowserWorkspaceHistory", () => {
  function tab(history: string[], historyIndex: number) {
    return { history, historyIndex } as unknown as WebBrowserWorkspaceTabState;
  }

  it("appends when already at the tip", () => {
    const state = tab(["/a", "/b"], 1);
    pushWebBrowserWorkspaceHistory(state, "/c");
    expect(state.history).toEqual(["/a", "/b", "/c"]);
    expect(state.historyIndex).toBe(2);
  });

  it("TRUNCATES forward history when navigating from a back position", () => {
    // This is the defining browser rule: going back and then navigating
    // discards everything that was ahead. Without the slice, the forward
    // entries survive and Forward would jump to a page the user abandoned.
    const state = tab(["/a", "/b", "/c", "/d"], 1);
    pushWebBrowserWorkspaceHistory(state, "/new");
    expect(state.history).toEqual(["/a", "/b", "/new"]);
    expect(state.historyIndex).toBe(2);
  });

  it("truncates everything when back at the very first entry", () => {
    const state = tab(["/a", "/b", "/c"], 0);
    pushWebBrowserWorkspaceHistory(state, "/new");
    expect(state.history).toEqual(["/a", "/new"]);
    expect(state.historyIndex).toBe(1);
  });

  it("always leaves the index pointing at the new entry", () => {
    for (const [history, index] of [
      [[], -1],
      [["/a"], 0],
      [["/a", "/b", "/c"], 2],
      [["/a", "/b", "/c"], 0],
    ] as const) {
      const state = tab([...history], index);
      pushWebBrowserWorkspaceHistory(state, "/x");
      expect(state.historyIndex).toBe(state.history.length - 1);
      expect(state.history[state.historyIndex]).toBe("/x");
    }
  });

  it("starts a fresh stack from an empty history", () => {
    const state = tab([], -1);
    pushWebBrowserWorkspaceHistory(state, "/first");
    expect(state.history).toEqual(["/first"]);
    expect(state.historyIndex).toBe(0);
  });

  it("keeps a repeated URL as its own entry", () => {
    // No de-duplication: reloading the same URL is a real navigation, and
    // collapsing it would desynchronize the index from the user's Back count.
    const state = tab(["/a"], 0);
    pushWebBrowserWorkspaceHistory(state, "/a");
    expect(state.history).toEqual(["/a", "/a"]);
    expect(state.historyIndex).toBe(1);
  });

  it("replaces the array rather than mutating the previous one in place", () => {
    // Callers snapshot `history` for undo/inspection; an in-place splice would
    // retroactively change a snapshot they already hold.
    const original = ["/a", "/b", "/c"];
    const state = tab(original, 1);
    pushWebBrowserWorkspaceHistory(state, "/new");
    expect(original).toEqual(["/a", "/b", "/c"]);
    expect(state.history).not.toBe(original);
  });
});
