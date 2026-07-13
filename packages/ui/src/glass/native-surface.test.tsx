// @vitest-environment jsdom
/**
 * Lifecycle contract for the shared native-surface hook: attach on enable,
 * one rAF-coalesced updateGeometry per resize, setProps on prop change without
 * remount, detach on disable/unmount, and a clean DOM-fallback when the driver
 * reports unavailable. jsdom harness with a fake driver — the real native path
 * is covered on-device.
 */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NativeSurfaceDriver,
  type NativeSurfaceHandle,
  useNativePlatformSurface,
} from "./native-surface";

beforeEach(() => {
  // jsdom has no ResizeObserver; the hook uses it for rect sync.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});
afterEach(cleanup);

type Props = { label: string };

function makeDriver(available: boolean) {
  const handle: NativeSurfaceHandle<Props> & {
    updateGeometry: ReturnType<typeof vi.fn>;
    setProps: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  } = {
    updateGeometry: vi.fn(),
    setProps: vi.fn(),
    detach: vi.fn(),
  };
  const driver: NativeSurfaceDriver<Props> = {
    name: "test",
    isAvailable: vi.fn(async () => available),
    attach: vi.fn(async () => (available ? handle : null)),
  };
  return { driver, handle };
}

function Harness({
  driver,
  enabled,
  label,
}: {
  driver: NativeSurfaceDriver<Props>;
  enabled: boolean;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { active } = useNativePlatformSurface(driver, {
    ref,
    enabled,
    props: { label },
  });
  return (
    <div ref={ref} data-testid="anchor" data-active={active ? "on" : "off"} />
  );
}

describe("useNativePlatformSurface", () => {
  it("attaches when enabled + available, reports active, detaches on unmount", async () => {
    const { driver, handle } = makeDriver(true);
    const { getByTestId, unmount } = render(
      <Harness driver={driver} enabled label="hi" />,
    );
    await waitFor(() =>
      expect(getByTestId("anchor").getAttribute("data-active")).toBe("on"),
    );
    expect(driver.attach).toHaveBeenCalledTimes(1);
    unmount();
    expect(handle.detach).toHaveBeenCalledTimes(1);
  });

  it("stays DOM (never active) when the driver is unavailable", async () => {
    const { driver, handle } = makeDriver(false);
    const { getByTestId } = render(
      <Harness driver={driver} enabled label="hi" />,
    );
    // attach still runs but returns null → no handle, stays inactive.
    await waitFor(() => expect(driver.attach).toHaveBeenCalled());
    expect(getByTestId("anchor").getAttribute("data-active")).toBe("off");
    expect(handle.detach).not.toHaveBeenCalled();
  });

  it("does not attach while disabled, and attaches once enabled flips true", async () => {
    const { driver } = makeDriver(true);
    const { getByTestId, rerender } = render(
      <Harness driver={driver} enabled={false} label="hi" />,
    );
    expect(driver.attach).not.toHaveBeenCalled();
    rerender(<Harness driver={driver} enabled label="hi" />);
    await waitFor(() =>
      expect(getByTestId("anchor").getAttribute("data-active")).toBe("on"),
    );
    expect(driver.attach).toHaveBeenCalledTimes(1);
  });

  it("pushes setProps on a prop change WITHOUT remounting (attach stays 1)", async () => {
    const { driver, handle } = makeDriver(true);
    const { rerender, getByTestId } = render(
      <Harness driver={driver} enabled label="a" />,
    );
    await waitFor(() =>
      expect(getByTestId("anchor").getAttribute("data-active")).toBe("on"),
    );
    await act(async () => {
      rerender(<Harness driver={driver} enabled label="b" />);
    });
    expect(handle.setProps).toHaveBeenCalledWith({ label: "b" });
    expect(driver.attach).toHaveBeenCalledTimes(1); // no remount
    expect(handle.detach).not.toHaveBeenCalled();
  });

  it("coalesces a resize into a single updateGeometry per frame", async () => {
    const { driver, handle } = makeDriver(true);
    const { getByTestId } = render(
      <Harness driver={driver} enabled label="a" />,
    );
    await waitFor(() =>
      expect(getByTestId("anchor").getAttribute("data-active")).toBe("on"),
    );
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    // Three synchronous resizes → one coalesced geometry push.
    expect(handle.updateGeometry).toHaveBeenCalledTimes(1);
  });
});
