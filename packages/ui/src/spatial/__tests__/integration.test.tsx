// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  Card,
  evaluateToSpatialTree,
  HStack,
  SpatialSurface,
  Text,
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
  window.__elizaXRContext = undefined;
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
    expect(tree.title).toBe("Ops");
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
    expect(flat).toContain("Ops");
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
