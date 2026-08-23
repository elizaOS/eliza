/**
 * Covers the non-model branches of the Code example status bar through the
 * real component: frame geometry, room labeling and indexing, task counters,
 * width tiers, cwd elision, and the 500ms cwd refresh throttle. Harness is
 * deterministic — real zustand store with persistence disabled, chalk color
 * forced off, and model-provider env keys cleared (the model indicator itself
 * is covered by status-bar-model.test.ts).
 */
import { stringToUuid } from "@elizaos/core";
import { visibleWidth } from "@elizaos/tui";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getCwd, setCwd } from "../lib/cwd.js";
import { useStore } from "../lib/store.js";
import type { ChatRoom, CodeTask, TaskStatus } from "../types.js";
import { StatusBar } from "./StatusBar.js";

const MODEL_ENV_KEYS = [
  "ELIZA_CODE_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_LARGE_MODEL",
  "OPENAI_MODEL",
  "OPENAI_SMALL_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_LARGE_MODEL",
] as const;

const savedEnv: Record<string, string | undefined> = {};
const prevChalkLevel = chalk.level;
let taskSeq = 0;

function room(id: string, name: string): ChatRoom {
  return {
    id,
    name,
    messages: [],
    createdAt: new Date(),
    taskIds: [],
    elizaRoomId: stringToUuid(`status-bar-test:${id}`),
  };
}

function task(status: TaskStatus): CodeTask {
  taskSeq += 1;
  return {
    id: stringToUuid(`status-bar-test:${taskSeq}:${status}`),
    name: `task-${taskSeq}`,
    metadata: {
      status,
      progress: 0,
      output: [],
      steps: [],
      workingDirectory: "/tmp",
      createdAt: 1,
    },
  };
}

function seedRooms(...rooms: ChatRoom[]): void {
  useStore.setState({ rooms, currentRoomId: rooms[0].id });
}

/** Pins the instance cwd so assertions never depend on the machine path. */
function pinnedBar(cwd: string): StatusBar {
  const bar = new StatusBar();
  (bar as unknown as { cwd: string }).cwd = cwd;
  return bar;
}

beforeEach(() => {
  process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE = "1";
  chalk.level = 0;
  for (const key of MODEL_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  useStore.setState({
    rooms: [],
    tasks: [],
    currentTaskId: null,
    isLoading: false,
    currentRoomId: "",
  });
});

afterEach(() => {
  chalk.level = prevChalkLevel;
  for (const key of MODEL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("StatusBar", () => {
  test("renders a three-line frame whose content line fills the width exactly", () => {
    seedRooms(room("r1", "Main"));
    const lines = pinnedBar("/tmp/eliza-code").render(80);
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith("┌")).toBe(true);
    expect(lines[0].endsWith("┐")).toBe(true);
    expect(lines[0].split("─")).toHaveLength(77); // innerWidth = width - 4
    expect(lines[2].startsWith("└")).toBe(true);
    expect(lines[2].endsWith("┘")).toBe(true);
    expect(lines[1].startsWith("│")).toBe(true);
    expect(lines[1].endsWith("│")).toBe(true);
    expect(visibleWidth(lines[1])).toBe(80);
  });

  test("right-aligns the task row against the right border", () => {
    seedRooms(room("r1", "Main"));
    const content = pinnedBar("/tmp/eliza-code").render(80)[1];
    expect(content.endsWith("? │")).toBe(true);
  });

  test("labels the current room with its name and one-based position", () => {
    seedRooms(room("r1", "Main"));
    const joined = pinnedBar("/tmp/eliza-code").render(80).join("\n");
    expect(joined).toContain("Main");
    expect(joined).toContain("(1/1)");
  });

  test("reports position among multiple rooms", () => {
    const rooms = [
      room("r1", "Alpha"),
      room("r2", "Beta"),
      room("r3", "Gamma"),
    ];
    useStore.setState({ rooms, currentRoomId: "r2" });
    const joined = pinnedBar("/tmp/eliza-code").render(80).join("\n");
    expect(joined).toContain("Beta");
    expect(joined).toContain("(2/3)");
  });

  test("falls back to Chat and a zero index when the current room is missing", () => {
    seedRooms(room("r1", "Main"));
    useStore.setState({ currentRoomId: "ghost-room" });
    const joined = pinnedBar("/tmp/eliza-code").render(80).join("\n");
    expect(joined).toContain("Chat");
    expect(joined).toContain("(0/1)");
  });

  test("counts each task status independently and ignores non-counted statuses", () => {
    seedRooms(room("r1", "Main"));
    useStore.setState({
      tasks: [
        task("running"),
        task("running"),
        task("completed"),
        task("completed"),
        task("completed"),
        task("failed"),
        task("cancelled"),
        task("cancelled"),
        task("cancelled"),
        task("cancelled"),
        task("pending"),
        task("paused"),
      ],
    });
    const joined = pinnedBar("/tmp/eliza-code").render(100).join("\n");
    expect(joined).toContain("Tasks r2 c3 f1 x4");
  });

  test("reports an all-zero counter row when the task queue is empty", () => {
    seedRooms(room("r1", "Main"));
    const joined = pinnedBar("/tmp/eliza-code").render(100).join("\n");
    expect(joined).toContain("Tasks r0 c0 f0 x0");
  });

  test("appends the busy marker to the counter row only while loading", () => {
    seedRooms(room("r1", "Main"));
    const bar = pinnedBar("/tmp/eliza-code");
    expect(bar.render(100).join("\n")).not.toContain("…");
    useStore.getState().setLoading(true);
    expect(bar.render(100).join("\n")).toContain("Tasks r0 c0 f0 x0 …");
  });

  test("drops completed and cancelled counters from the medium width tier", () => {
    seedRooms(room("r1", "Main"));
    useStore.setState({
      tasks: [
        task("running"),
        task("running"),
        task("completed"),
        task("completed"),
        task("completed"),
        task("failed"),
        task("cancelled"),
        task("cancelled"),
        task("cancelled"),
        task("cancelled"),
      ],
    });
    const joined = pinnedBar("/tmp/eliza-code").render(70).join("\n");
    expect(joined).toContain("Tasks r2 f1");
    expect(joined).not.toContain("c3");
    expect(joined).not.toContain("x4");
  });

  test("keeps only the running counter in the narrow width tier", () => {
    seedRooms(room("r1", "Main"));
    useStore.setState({
      tasks: [task("running"), task("running"), task("failed")],
    });
    const joined = pinnedBar("/tmp/eliza-code").render(40).join("\n");
    expect(joined).toContain("Tasks r2");
    expect(joined).not.toContain("f1");
  });

  test("elides a cwd longer than its slot from the left, keeping the tail", () => {
    seedRooms(room("r1", "Main"));
    const deep = `/${"x".repeat(120)}-tail-end`;
    const joined = pinnedBar(deep).render(100).join("\n");
    expect(joined).toContain("...");
    expect(joined).toContain("-tail-end");
    expect(joined).not.toContain("x".repeat(63));
  });

  test("elides a room name beyond 20 visible characters", () => {
    seedRooms(room("r1", "a".repeat(30)));
    const joined = pinnedBar("/tmp/eliza-code").render(120).join("\n");
    expect(joined).toContain(`${"a".repeat(19)}…`);
    expect(joined).not.toContain("a".repeat(20));
  });

  test("squeezes the room name further when the row would overflow when narrow", () => {
    seedRooms(room("r1", "b".repeat(30)));
    const lines = pinnedBar(`/n/${"y".repeat(80)}`).render(48);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(48);
    }
    const joined = lines.join("\n");
    expect(joined).toContain("…");
    expect(joined).not.toContain("b".repeat(30));
  });

  test("refreshes the cwd only after the 500ms throttle window elapses", async () => {
    const originalCwd = getCwd();
    // Construct first so the instance snapshots the pre-move cwd.
    const bar = new StatusBar();
    const moved = await setCwd("/tmp");
    expect(moved.success).toBe(true);
    try {
      // Within the window the constructor snapshot stays, even though the
      // module-level cwd has already moved.
      expect(bar.render(140).join("\n")).toContain(originalCwd);
      (bar as unknown as { lastCwdCheck: number }).lastCwdCheck =
        Date.now() - 501;
      expect(bar.render(140).join("\n")).toContain("/tmp");
    } finally {
      await setCwd(originalCwd);
    }
  });

  test("still returns a full frame below the minimum usable width", () => {
    seedRooms(room("r1", "Main"));
    const lines = pinnedBar("/t").render(12);
    expect(lines).toHaveLength(3);
  });
});
