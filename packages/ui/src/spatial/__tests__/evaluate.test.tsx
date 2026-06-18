import { describe, expect, it } from "vitest";
import {
  Button,
  evaluateToSpatialTree,
  HStack,
  List,
  Stack,
  Text,
  useSpatialState,
} from "../index.ts";
import type { SpatialBoxNode } from "../ir.ts";
import { createSpatialTuiComponent } from "../tui/index.ts";

describe("evaluate — React tree → IR", () => {
  it("evaluates a primitive box with text children", () => {
    const tree = evaluateToSpatialTree(
      <Stack gap={1}>
        <Text>hello</Text>
        <Text tone="muted">world</Text>
      </Stack>,
    ) as SpatialBoxNode;
    expect(tree.type).toBe("box");
    expect(tree.direction).toBe("column");
    expect(tree.gap).toBe(1);
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0]).toMatchObject({ type: "text", value: "hello" });
    expect(tree.children[1]).toMatchObject({
      type: "text",
      value: "world",
      tone: "muted",
    });
  });

  it("invokes function components and the HStack/List sugar", () => {
    function Row({ label }: { label: string }) {
      return (
        <HStack gap={2}>
          <Text>{label}</Text>
        </HStack>
      );
    }
    const tree = evaluateToSpatialTree(<Row label="hi" />) as SpatialBoxNode;
    expect(tree.type).toBe("box");
    expect(tree.direction).toBe("row");
    expect(tree.gap).toBe(2);
    expect(tree.children[0]).toMatchObject({ type: "text", value: "hi" });
  });

  it("expands .map() and skips null/false conditionals", () => {
    const items = ["a", "b", "c"];
    const tree = evaluateToSpatialTree(
      <List>
        {items.map((i) => (
          <Text key={i}>{i}</Text>
        ))}
        {false}
        {null}
        {items.length > 5 ? <Text>too many</Text> : null}
      </List>,
    ) as SpatialBoxNode;
    expect(tree.children).toHaveLength(3);
    expect(
      tree.children.map((c) => (c.type === "text" ? c.value : "")),
    ).toEqual(["a", "b", "c"]);
  });

  it("flattens fragments and bare string children", () => {
    const tree = evaluateToSpatialTree(
      <Stack>
        {/* biome-ignore lint/complexity/noUselessFragments: the fragment is the subject under test */}
        <>
          <Text>one</Text>
          <Text>two</Text>
        </>
      </Stack>,
    ) as SpatialBoxNode;
    expect(tree.children).toHaveLength(2);
  });

  it("reads useSpatialState's initial value during a stateless snapshot", () => {
    function Counter() {
      const [n] = useSpatialState(3);
      return <Text>{`n=${n}`}</Text>;
    }
    const tree = evaluateToSpatialTree(<Counter />);
    expect(tree).toMatchObject({ type: "text", value: "n=3" });
  });

  it("carries agent metadata onto interactive nodes", () => {
    const tree = evaluateToSpatialTree(<Button agent="save">Save</Button>);
    expect(tree).toMatchObject({
      type: "button",
      label: "Save",
      agent: { id: "save" },
    });
  });
});

describe("evaluate — cross-frame state via the TUI component adapter", () => {
  it("persists useSpatialState across re-renders and re-snapshots on change", () => {
    const captured: { set?: (v: number | ((p: number) => number)) => void } =
      {};
    function Counter() {
      const [n, setN] = useSpatialState(0);
      captured.set = setN;
      return <Text>{`n=${n}`}</Text>;
    }

    let changes = 0;
    const comp = createSpatialTuiComponent(() => <Counter />, {
      onChange: () => {
        changes += 1;
      },
    });

    expect(comp.render(10)[0]).toContain("n=0");
    captured.set?.(7);
    expect(changes).toBe(1);
    expect(comp.render(10)[0]).toContain("n=7");
    captured.set?.((p: number) => p + 1);
    expect(comp.render(10)[0]).toContain("n=8");
  });
});
