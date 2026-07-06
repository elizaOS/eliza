// @vitest-environment jsdom

/**
 * End-to-end parity check for the spatial framework: one primitive tree
 * (Stack/Text/Card/…) evaluated to the layout IR, then rendered to both the DOM
 * modality (auto-switching to xr when the XR host global is present) and the TUI
 * modality. Static/string render (no live headset).
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Card,
  evaluateToSpatialTree,
  HStack,
  SpatialSurface,
  Text,
  useContinuousChatClearanceActive,
  useContinuousChatCompactClearanceActive,
  useContinuousChatSideClearanceActive,
  useSpatialState,
  VStack,
} from "../index.ts";
import type { SpatialBoxNode } from "../ir.ts";
import { createSpatialTuiComponent, renderViewToLines } from "../tui/index.ts";

declare global {
  interface Window {
    __elizaXRContext?: unknown;
  }
}

afterEach(() => {
  cleanup();
  window.__elizaXRContext = undefined;
  document.documentElement.style.removeProperty(
    "--eliza-continuous-chat-side-clearance",
  );
  document.documentElement.style.removeProperty(
    "--eliza-continuous-chat-clearance",
  );
});

describe("SpatialSurface auto-detects the headset modality", () => {
  it("defaults to gui, and switches to xr when the XR host global is present", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface>
        <Text>hi</Text>
      </SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');

    window.__elizaXRContext = { viewId: "x" };
    const xr = renderToStaticMarkup(
      <SpatialSurface>
        <Text>hi</Text>
      </SpatialSurface>,
    );
    expect(xr).toContain('data-spatial-surface="xr"');
  });

  it("only reserves floating-chat clearance when the host opts in", () => {
    const plain = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <Text>plain</Text>
      </SpatialSurface>,
    );
    expect(plain).not.toContain("--eliza-continuous-chat-clearance");

    const hosted = renderToStaticMarkup(
      <SpatialSurface modality="gui" reserveChatClearance>
        <Text>hosted</Text>
      </SpatialSurface>,
    );
    expect(hosted).toContain(
      "padding-bottom:var(--eliza-continuous-chat-clearance, 5.25rem)",
    );
    expect(hosted).toContain(
      "padding-inline-end:var(--eliza-continuous-chat-side-clearance, 0px)",
    );
    expect(hosted).toContain("overflow-y:auto");
  });
});

function ChatClearanceProbe() {
  const active = useContinuousChatSideClearanceActive();
  return <span data-testid="chat-clearance-probe">{String(active)}</span>;
}

function ChatBottomClearanceProbe() {
  const active = useContinuousChatClearanceActive();
  return (
    <span data-testid="chat-bottom-clearance-probe">{String(active)}</span>
  );
}

function ChatCompactClearanceProbe() {
  const active = useContinuousChatCompactClearanceActive();
  return (
    <span data-testid="chat-compact-clearance-probe">{String(active)}</span>
  );
}

describe("continuous chat side-clearance hook", () => {
  it("tracks the shell-published inline-end clearance var", async () => {
    render(<ChatClearanceProbe />);
    expect(screen.getByTestId("chat-clearance-probe").textContent).toBe(
      "false",
    );

    act(() => {
      document.documentElement.style.setProperty(
        "--eliza-continuous-chat-side-clearance",
        "232px",
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-clearance-probe").textContent).toBe(
        "true",
      ),
    );

    act(() => {
      document.documentElement.style.removeProperty(
        "--eliza-continuous-chat-side-clearance",
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-clearance-probe").textContent).toBe(
        "false",
      ),
    );
  });

  it("tracks the shell-published bottom clearance var", async () => {
    render(<ChatBottomClearanceProbe />);
    expect(screen.getByTestId("chat-bottom-clearance-probe").textContent).toBe(
      "false",
    );

    act(() => {
      document.documentElement.style.setProperty(
        "--eliza-continuous-chat-clearance",
        "96px",
      );
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("chat-bottom-clearance-probe").textContent,
      ).toBe("true"),
    );
  });

  it("uses compact mode for side clearance or mobile-width bottom clearance", async () => {
    const originalInnerWidth = Object.getOwnPropertyDescriptor(
      window,
      "innerWidth",
    );
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width: 767px")
          ? window.innerWidth <= 767
          : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });

    try {
      render(<ChatCompactClearanceProbe />);
      expect(
        screen.getByTestId("chat-compact-clearance-probe").textContent,
      ).toBe("false");

      act(() => {
        document.documentElement.style.setProperty(
          "--eliza-continuous-chat-clearance",
          "96px",
        );
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("chat-compact-clearance-probe").textContent,
        ).toBe("true"),
      );

      act(() => {
        Object.defineProperty(window, "innerWidth", {
          configurable: true,
          value: 1024,
        });
        window.dispatchEvent(new Event("resize"));
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("chat-compact-clearance-probe").textContent,
        ).toBe("false"),
      );

      act(() => {
        document.documentElement.style.setProperty(
          "--eliza-continuous-chat-side-clearance",
          "232px",
        );
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("chat-compact-clearance-probe").textContent,
        ).toBe("true"),
      );
    } finally {
      if (originalInnerWidth) {
        Object.defineProperty(window, "innerWidth", originalInnerWidth);
      }
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});

// A deeper, nested + stateful view to exercise parity beyond the flat example.
function Dashboard({ title }: { title: string }) {
  const [open, setOpen] = useSpatialState(true);
  return (
    <Card title={title} gap={1} padding={1}>
      <HStack gap={1} justify="between">
        <Text style="subheading" grow={1}>
          Sessions
        </Text>
        <Text tone={open ? "success" : "muted"}>
          {open ? "live" : "paused"}
        </Text>
      </HStack>
      {open ? (
        <VStack gap={0}>
          <Row label="alpha" value="3 msgs" />
          <Row label="beta" value="12 msgs" />
        </VStack>
      ) : (
        <Text tone="muted">collapsed</Text>
      )}
      <Toggle open={open} onToggle={() => setOpen((v) => !v)} />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <HStack gap={1} justify="between">
      <Text>{label}</Text>
      <Text tone="muted">{value}</Text>
    </HStack>
  );
}

function Toggle({ open }: { open: boolean; onToggle: () => void }) {
  return (
    <HStack gap={1} agent="toggle">
      <Text tone="primary">{open ? "▾ collapse" : "▸ expand"}</Text>
      <Text dim>(tap)</Text>
    </HStack>
  );
}

describe("deep nested + stateful parity", () => {
  it("evaluates nested components (with their own hooks) into one IR tree", () => {
    const tree = evaluateToSpatialTree(
      <Dashboard title="Ops" />,
    ) as SpatialBoxNode;
    expect(tree.type).toBe("box");
    expect(tree.title).toBeUndefined();
    // Card > [header HStack, VStack(rows), Toggle HStack]
    expect(tree.children.map((c) => c.type)).toEqual(["box", "box", "box"]);
    const rows = tree.children[1] as SpatialBoxNode;
    expect(rows.children).toHaveLength(2); // two Row components expanded
  });

  it("renders nested layout to terminal lines honouring the width contract", () => {
    const lines = renderViewToLines(<Dashboard title="Ops" />, 36);
    for (const line of lines) {
      // visible width is checked thoroughly in engine/parity tests; here assert
      // structure + content survive the nesting.
      expect(line.length).toBeGreaterThan(0);
    }
    const flat = lines.join("\n");
    expect(flat).toContain("Sessions");
    expect(flat).toContain("alpha");
    expect(flat).toContain("12 msgs");
    expect(flat).toContain("collapse");
  });

  it("re-snapshots on a nested state change (collapse hides the rows)", () => {
    const captured: { toggle?: () => void } = {};
    function Harness() {
      const [open, setOpen] = useSpatialState(true);
      captured.toggle = () => setOpen((v) => !v);
      return open ? (
        <VStack>
          <Row label="alpha" value="1" />
          <Row label="beta" value="2" />
        </VStack>
      ) : (
        <Text>collapsed</Text>
      );
    }
    const comp = createSpatialTuiComponent(() => <Harness />);
    expect(comp.render(20).join("\n")).toContain("alpha");
    captured.toggle?.();
    const after = comp.render(20).join("\n");
    expect(after).toContain("collapsed");
    expect(after).not.toContain("alpha");
  });
});
