/**
 * Unit tests for runDomAction over a jsdom DOM (test-dom-setup): click / type /
 * submit behavior and handling of hostile input and invalid targets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-dom-setup";
import { runDomAction } from "./dom-actions";

describe("runDomAction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("types into inputs and dispatches input/change events for hostile text literally", () => {
    document.body.innerHTML = `<textarea id="target" name="message"></textarea>`;
    const input = document.querySelector("#target") as HTMLTextAreaElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    const text = `<img src=x onerror=alert(1)>\nhello`;
    expect(runDomAction({ kind: "type", selector: "#target", text })).toEqual({
      selector: "message",
      valueLength: text.length,
    });

    expect(input.value).toBe(text);
    expect(events).toEqual(["input", "change"]);
  });

  it("types into contenteditable elements without interpreting markup", () => {
    document.body.innerHTML = `<div id="editor" contenteditable="true"></div>`;
    const editor = document.querySelector("#editor") as HTMLElement;
    Object.defineProperty(editor, "isContentEditable", {
      configurable: true,
      value: true,
    });

    runDomAction({
      kind: "type",
      selector: "#editor",
      text: "<script>alert(1)</script>",
    });

    expect(editor.textContent).toBe("<script>alert(1)</script>");
    expect(editor.innerHTML).not.toContain("<script>");
  });

  it("clicks enabled elements after scrolling them into view", () => {
    document.body.innerHTML = `<button id="target" type="button">Run</button>`;
    const button = document.querySelector("#target") as HTMLButtonElement;
    Object.defineProperty(button, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    const scrollIntoView = vi
      .spyOn(button, "scrollIntoView")
      .mockImplementation(() => undefined);
    const clicks: string[] = [];
    button.addEventListener("click", () => clicks.push("clicked"));

    expect(runDomAction({ kind: "click", selector: "#target" })).toEqual({
      selector: "#target",
      tagName: "button",
    });

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "center",
    });
    expect(clicks).toEqual(["clicked"]);
  });

  it("rejects invalid selectors, disabled controls, readonly inputs, and unsupported targets", () => {
    document.body.innerHTML = [
      `<button id="disabled" disabled>Disabled</button>`,
      `<input id="readonly" readonly />`,
      `<section id="plain"></section>`,
    ].join("");

    expect(() => runDomAction({ kind: "click", selector: "[" })).toThrow(
      /Invalid selector/,
    );
    expect(() =>
      runDomAction({ kind: "click", selector: "#disabled" }),
    ).toThrow(/disabled/);
    expect(() =>
      runDomAction({ kind: "type", selector: "#readonly", text: "nope" }),
    ).toThrow(/read-only/);
    expect(() =>
      runDomAction({ kind: "type", selector: "#plain", text: "nope" }),
    ).toThrow(/does not support typing/);
  });

  it("submits the nearest form and reports the action URL", () => {
    document.body.innerHTML = `
      <form id="form" action="/submit">
        <input id="field" name="field" />
      </form>
    `;
    const form = document.querySelector("#form") as HTMLFormElement;
    const requestSubmit = vi
      .spyOn(form, "requestSubmit")
      .mockImplementation(() => undefined);

    expect(runDomAction({ kind: "submit", selector: "#field" })).toEqual({
      action: "https://unit-test.local/submit",
    });
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it("routes history actions to browser history primitives", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const forward = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});

    expect(runDomAction({ kind: "history_back" })).toEqual({
      direction: "back",
    });
    expect(runDomAction({ kind: "history_forward" })).toEqual({
      direction: "forward",
    });
    expect(back).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
  });
});
