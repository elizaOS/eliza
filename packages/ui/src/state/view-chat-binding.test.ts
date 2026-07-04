// @vitest-environment jsdom
/**
 * The view↔chat binding registry (`view-chat-binding`): the module-level
 * current binding and the `useRegisterViewChatBinding` hook that sets it on
 * mount and clears it on unmount. Real hook under jsdom.
 */
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getViewChatBinding,
  setViewChatBinding,
  useRegisterViewChatBinding,
  type ViewChatBinding,
} from "./view-chat-binding";

afterEach(() => {
  cleanup();
  setViewChatBinding(null);
});

function Harness(props: { binding: ViewChatBinding | null }) {
  useRegisterViewChatBinding(props.binding);
  return null;
}

describe("view-chat-binding onSubmit", () => {
  it("registers onSubmit while mounted and clears it on unmount", () => {
    const onSubmit = vi.fn(() => true);
    const { unmount } = render(
      createElement(Harness, { binding: { onSubmit } }),
    );
    const b = getViewChatBinding();
    expect(b?.onSubmit).toBe(onSubmit);
    // and it actually routes: returns true (consumes) + receives the text
    expect(b?.onSubmit?.("fix the bug")).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith("fix the bug");
    unmount();
    expect(getViewChatBinding()).toBeNull();
  });

  it("re-registers when the onSubmit identity changes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = render(
      createElement(Harness, { binding: { onSubmit: a } }),
    );
    expect(getViewChatBinding()?.onSubmit).toBe(a);
    rerender(createElement(Harness, { binding: { onSubmit: b } }));
    expect(getViewChatBinding()?.onSubmit).toBe(b);
  });

  it("a null binding (driver mode) registers nothing", () => {
    render(createElement(Harness, { binding: null }));
    expect(getViewChatBinding()).toBeNull();
  });
});
