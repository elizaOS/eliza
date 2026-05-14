// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADVANCED_TOGGLE_STORAGE_KEY,
  AdvancedToggle,
  useAdvancedSettingsEnabled,
} from "./AdvancedToggle";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("AdvancedToggle", () => {
  it("renders OFF by default when localStorage has no value", () => {
    const { getByRole } = render(<AdvancedToggle />);
    const sw = getByRole("switch") as HTMLButtonElement;
    expect(sw.getAttribute("data-state")).toBe("unchecked");
  });

  it("reads initial state from localStorage when present", () => {
    window.localStorage.setItem(ADVANCED_TOGGLE_STORAGE_KEY, "1");
    const { getByRole } = render(<AdvancedToggle />);
    const sw = getByRole("switch") as HTMLButtonElement;
    expect(sw.getAttribute("data-state")).toBe("checked");
  });

  it("clicking the switch persists the new state to localStorage", () => {
    const { getByRole } = render(<AdvancedToggle />);
    const sw = getByRole("switch") as HTMLButtonElement;
    act(() => {
      fireEvent.click(sw);
    });
    expect(window.localStorage.getItem(ADVANCED_TOGGLE_STORAGE_KEY)).toBe("1");
    expect(sw.getAttribute("data-state")).toBe("checked");

    act(() => {
      fireEvent.click(sw);
    });
    expect(window.localStorage.getItem(ADVANCED_TOGGLE_STORAGE_KEY)).toBe("0");
    expect(sw.getAttribute("data-state")).toBe("unchecked");
  });

  it("calls the optional onChange handler with the new state", () => {
    const seen: boolean[] = [];
    const { getByRole } = render(
      <AdvancedToggle onChange={(v) => seen.push(v)} />,
    );
    const sw = getByRole("switch") as HTMLButtonElement;
    act(() => {
      fireEvent.click(sw);
    });
    expect(seen).toEqual([true]);
  });

  it("two toggles on the same page stay in sync via the listener cascade", () => {
    const { getAllByRole } = render(
      <>
        <AdvancedToggle />
        <AdvancedToggle />
      </>,
    );
    const [first, second] = getAllByRole("switch") as HTMLButtonElement[];
    expect(first?.getAttribute("data-state")).toBe("unchecked");
    expect(second?.getAttribute("data-state")).toBe("unchecked");
    act(() => {
      if (first) fireEvent.click(first);
    });
    expect(first?.getAttribute("data-state")).toBe("checked");
    expect(second?.getAttribute("data-state")).toBe("checked");
  });

  it("supports a custom label", () => {
    const { getByText } = render(<AdvancedToggle label="Power user mode" />);
    expect(getByText("Power user mode")).toBeTruthy();
  });
});

describe("useAdvancedSettingsEnabled", () => {
  it("returns false by default", () => {
    const { result } = renderHook(() => useAdvancedSettingsEnabled());
    expect(result.current).toBe(false);
  });

  it("returns true when localStorage already has '1'", () => {
    window.localStorage.setItem(ADVANCED_TOGGLE_STORAGE_KEY, "1");
    const { result } = renderHook(() => useAdvancedSettingsEnabled());
    expect(result.current).toBe(true);
  });

  it("subscribes to changes from an <AdvancedToggle /> elsewhere on the page", () => {
    const hookResult = renderHook(() => useAdvancedSettingsEnabled());
    const { getByRole } = render(<AdvancedToggle />);
    expect(hookResult.result.current).toBe(false);
    const sw = getByRole("switch") as HTMLButtonElement;
    act(() => {
      fireEvent.click(sw);
    });
    expect(hookResult.result.current).toBe(true);
  });
});
