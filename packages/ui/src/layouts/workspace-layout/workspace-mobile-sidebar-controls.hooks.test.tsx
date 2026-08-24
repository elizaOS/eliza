/** Verifies the mobile sidebar controls context hooks through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Verifies `WorkspaceMobileSidebarControlsContext`,
 * `useWorkspaceMobileSidebarControls`, and `useWorkspaceMobileSidebarHeader`
 * against the real hooks: null outside a provider, drawer-to-header wiring
 * through the real context, first-registered-drawer exposure, same-id
 * replacement in place, unregister-by-id teardown with next-in-line
 * promotion, and safe disposal of an already-removed id. Renders through
 * @testing-library/react on jsdom (no real viewport).
 */

import { act, cleanup, render, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  useWorkspaceMobileSidebarControls,
  useWorkspaceMobileSidebarHeader,
  type WorkspaceMobileSidebarControl,
  WorkspaceMobileSidebarControlsContext,
} from "./workspace-mobile-sidebar-controls.hooks";

function makeControl(id: string, open = false): WorkspaceMobileSidebarControl {
  return { id, label: `Label ${id}`, open, setOpen: () => {} };
}

afterEach(() => {
  cleanup();
});

describe("useWorkspaceMobileSidebarControls", () => {
  it("returns null when no provider above the consumer owns the controls", () => {
    const { result } = renderHook(() => useWorkspaceMobileSidebarControls());

    expect(result.current).toBeNull();
  });

  it("hands a nested drawer the owner's controls so its registration surfaces in the header", () => {
    const header = renderHook(() => useWorkspaceMobileSidebarHeader());
    let dispose: (() => void) | undefined;

    function Provider({ children }: { children: React.ReactNode }) {
      return (
        <WorkspaceMobileSidebarControlsContext.Provider
          value={header.result.current.controls}
        >
          {children}
        </WorkspaceMobileSidebarControlsContext.Provider>
      );
    }

    const drawer = renderHook(() => useWorkspaceMobileSidebarControls(), {
      wrapper: Provider,
    });

    expect(drawer.result.current).not.toBeNull();
    act(() => {
      dispose = drawer.result.current?.register(makeControl("drawer-nested"));
    });

    expect(header.result.current.control?.id).toBe("drawer-nested");

    act(() => {
      dispose?.();
    });

    expect(header.result.current.control).toBeNull();
  });
});

describe("useWorkspaceMobileSidebarHeader", () => {
  it("reports no control before any drawer registers", () => {
    const { result } = renderHook(() => useWorkspaceMobileSidebarHeader());

    expect(result.current.control).toBeNull();
    expect(typeof result.current.controls.register).toBe("function");
  });

  it("exposes the first registered drawer even after later registrations", () => {
    const { result } = renderHook(() => useWorkspaceMobileSidebarHeader());

    act(() => {
      result.current.controls.register(makeControl("drawer-first"));
    });
    act(() => {
      result.current.controls.register(makeControl("drawer-second"));
    });

    expect(result.current.control?.id).toBe("drawer-first");
  });

  it("replaces an existing registration in place when the same id registers again", () => {
    const { result } = renderHook(() => useWorkspaceMobileSidebarHeader());

    act(() => {
      result.current.controls.register(makeControl("drawer-a"));
    });
    act(() => {
      result.current.controls.register(makeControl("drawer-b"));
    });
    act(() => {
      result.current.controls.register(makeControl("drawer-a", true));
    });

    // Same slot, updated value — not an append behind the older registration.
    expect(result.current.control?.id).toBe("drawer-a");
    expect(result.current.control?.open).toBe(true);
  });

  it("unregisters by id and promotes the next registered drawer", () => {
    const { result } = renderHook(() => useWorkspaceMobileSidebarHeader());
    let disposeFirst: () => void = () => {};

    act(() => {
      disposeFirst = result.current.controls.register(makeControl("drawer-a"));
    });
    act(() => {
      result.current.controls.register(makeControl("drawer-b"));
    });
    act(() => {
      result.current.controls.register(makeControl("drawer-c"));
    });

    act(() => {
      disposeFirst();
    });

    expect(result.current.control?.id).toBe("drawer-b");
  });

  it("treats repeated disposal as a no-op that keeps remaining drawers intact", () => {
    const { result } = renderHook(() => useWorkspaceMobileSidebarHeader());
    let dispose: () => void = () => {};

    act(() => {
      dispose = result.current.controls.register(makeControl("drawer-a"));
    });
    act(() => {
      result.current.controls.register(makeControl("drawer-b"));
    });

    act(() => {
      dispose();
      dispose();
    });

    expect(result.current.control?.id).toBe("drawer-b");
  });

  it("clears the header control when an effect-driven drawer unmounts", () => {
    const header = renderHook(() => useWorkspaceMobileSidebarHeader());

    function DrawerFixture() {
      const controls = React.useContext(WorkspaceMobileSidebarControlsContext);
      React.useEffect(() => {
        if (!controls) return undefined;
        return controls.register(makeControl("drawer-effect"));
      }, [controls]);
      return null;
    }

    const mounted = render(
      <WorkspaceMobileSidebarControlsContext.Provider
        value={header.result.current.controls}
      >
        <DrawerFixture />
      </WorkspaceMobileSidebarControlsContext.Provider>,
    );

    expect(header.result.current.control?.id).toBe("drawer-effect");

    mounted.unmount();

    expect(header.result.current.control).toBeNull();
  });
});
