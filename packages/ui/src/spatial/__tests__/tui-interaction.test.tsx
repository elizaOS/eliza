/**
 * Unit coverage for interactive TUI components (focus/state on Button via
 * useSpatialState). Pure, no live terminal.
 */
import { visibleWidth } from "@elizaos/tui";
import { describe, expect, it } from "vitest";
import { AgentProfileView } from "../example.tsx";
import { Button, HStack, Text, useSpatialState, VStack } from "../index.ts";
import { createSpatialTuiComponent } from "../tui/index.ts";

const profile = {
  name: "Ada",
  status: "online" as const,
  model: "eliza-1",
  skills: ["research", "coding", "scheduling", "memory"],
};

const hasInverse = (lines: string[]) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches the ANSI ESC (\x1b) byte that opens SGR inverse-video sequences in TUI output
  lines.some((l) => /\x1b\[[0-9;]*7[;m]/.test(l));

describe("tui interaction — keyboard focus + activation", () => {
  it("Enter on the focused button changes view state (expand skills)", () => {
    const c = createSpatialTuiComponent(() => (
      <AgentProfileView profile={profile} />
    ));

    const collapsed = c.render(48);
    // Default state shows only the first two skills.
    expect(collapsed.join("\n")).toContain("research");
    expect(collapsed.join("\n")).not.toContain("scheduling");
    // The focused button is highlighted (inverse video present).
    expect(hasInverse(collapsed)).toBe(true);

    // Activate the focused control (the only handler-backed button: toggle-skills).
    c.handleInput?.("\r");
    const expanded = c.render(48);
    expect(expanded.join("\n")).toContain("scheduling");
    expect(expanded.join("\n")).toContain("memory");
    // Width contract still holds after interaction.
    for (const l of expanded) expect(visibleWidth(l)).toBe(48);
  });

  it("Tab cycles focus between activatable buttons and Enter fires the right one", () => {
    const log: string[] = [];
    function TwoButtons() {
      const [n, setN] = useSpatialState(0);
      return (
        <VStack gap={1}>
          <Text>{`count=${n}`}</Text>
          <HStack gap={1}>
            <Button agent="inc" onPress={() => setN((v) => v + 1)}>
              Add
            </Button>
            <Button agent="reset" onPress={() => setN(0)}>
              Reset
            </Button>
          </HStack>
        </VStack>
      );
    }
    const c = createSpatialTuiComponent(() => <TwoButtons />, {
      onActivate: (id) => log.push(id),
    });

    c.render(30); // first render → focus defaults to "inc"
    c.handleInput?.("\r"); // activate inc → count=1
    expect(c.render(30).join("\n")).toContain("count=1");

    c.handleInput?.("\t"); // focus → reset
    c.handleInput?.("\r"); // activate reset → count=0
    expect(c.render(30).join("\n")).toContain("count=0");

    expect(log).toEqual(["inc", "reset"]);
  });
});
