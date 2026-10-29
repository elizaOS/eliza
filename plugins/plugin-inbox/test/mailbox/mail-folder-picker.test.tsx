// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissMailFolderMenu,
  MailFolderPicker,
} from "../../src/components/mailbox/MailFolderPicker.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("MailFolderPicker (fallback without the Popover API)", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("opens the menu, picks a folder and returns focus to the trigger", () => {
    const spam = vi.fn();
    act(() =>
      root.render(
        <MailFolderPicker
          menuId="test-folders"
          themeTokens={["--fg"]}
          folders={[
            { label: "Spam", pick: spam },
            { label: "Trash", pick: () => {}, disabled: true },
          ]}
        />,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>(
      ".mail-folder-trigger",
    )!;
    const menu = document.getElementById("test-folders")!;
    expect(trigger.textContent).toBe("More");
    expect(trigger.getAttribute("aria-controls")).toBe("test-folders");
    expect(menu.hidden).toBe(true);
    act(() => trigger.click());
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const [first, second] = Array.from(
      menu.querySelectorAll<HTMLButtonElement>("button"),
    );
    expect(second.disabled).toBe(true);
    act(() => first.click());
    expect(spam).toHaveBeenCalledOnce();
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("labels the trigger with the selected folder and closes on Escape", () => {
    act(() =>
      root.render(
        <MailFolderPicker
          selectedStyle={{ width: 112 }}
          folders={[{ label: "Sent", on: true, pick: () => {} }]}
        />,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>(
      ".mail-folder-trigger",
    )!;
    expect(trigger.textContent).toBe("Sent");
    expect(
      host.querySelector<HTMLElement>(".mail-folder-picker")!.style.width,
    ).toBe("112px");
    act(() => trigger.click());
    const option = document.querySelector(".mail-folder-option")!;
    expect(option.getAttribute("aria-checked")).toBe("true");
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.getElementById("mail-folders")!.hidden).toBe(true);
  });

  it("lets the Back router dismiss only a visible fallback menu", () => {
    act(() =>
      root.render(
        <MailFolderPicker folders={[{ label: "Spam", pick: () => {} }]} />,
      ),
    );
    expect(dismissMailFolderMenu()).toBe(false);
    act(() =>
      host.querySelector<HTMLButtonElement>(".mail-folder-trigger")!.click(),
    );
    const menu = document.getElementById("mail-folders")!;
    // jsdom has no layout: report the open menu as rendered.
    menu.getClientRects = () =>
      [{}] as unknown as DOMRectList;
    let dismissed = false;
    act(() => {
      dismissed = dismissMailFolderMenu();
    });
    expect(dismissed).toBe(true);
    expect(menu.hidden).toBe(true);
  });
});
