/**
 * Shared logic for the multi-task supervisor scenario. Kept here so both the
 * `.scenario.ts` (run by the scenario CLI) and `orchestrator-scenario-logic`
 * unit test exercise the SAME assertions against the real, pure supervisor
 * digest functions — no model, no sub-agent subprocess, so it runs keyless.
 */
import {
  composeRoomDigest,
  runSupervisorTick,
  type SupervisorTaskView,
} from "../../../src/services/task-supervisor-service";

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ROOM_B = "22222222-2222-4222-8222-222222222222";

export function multiTaskViews(): SupervisorTaskView[] {
  return [
    {
      id: "t-a1",
      label: "Refactor auth",
      status: "active",
      activeSessions: 1,
      sessionLabel: "opencode · acct-1",
      origin: { roomId: ROOM_A, source: "telegram" },
    },
    {
      id: "t-a2",
      label: "Add billing page",
      status: "validating",
      activeSessions: 1,
      sessionLabel: "claude · acct-2",
      origin: { roomId: ROOM_A, source: "telegram" },
    },
    {
      id: "t-b1",
      label: "Fix flaky CI",
      status: "blocked",
      activeSessions: 0,
      sessionLabel: null,
      origin: { roomId: ROOM_B, source: "discord" },
    },
    // Terminal status → excluded from the live digest.
    {
      id: "t-done",
      label: "Ship landing page",
      status: "done",
      activeSessions: 0,
      sessionLabel: null,
      origin: { roomId: ROOM_A, source: "telegram" },
    },
    // No chat origin → cannot be addressed, skipped entirely.
    {
      id: "t-null",
      label: "Background reindex",
      status: "active",
      activeSessions: 1,
      sessionLabel: null,
      origin: null,
    },
  ];
}

/** Returns undefined on success, or an error string describing the first failed
 * expectation (the scenario/finalCheck contract). */
export async function runMultiTaskSupervisorCheck(): Promise<
  string | undefined
> {
  const sent: Array<{ roomId: string; text: string }> = [];
  const send = async (
    target: { source: string; roomId: string },
    content: { text?: string },
  ) => {
    sent.push({ roomId: target.roomId, text: content.text ?? "" });
  };
  const seen = new Map<string, string>();

  // --- Tick 1: each live room gets its own digest (isolation). ---
  const tick1 = await runSupervisorTick(multiTaskViews(), send, seen);
  if (tick1.posted.length !== 2) {
    return `expected 2 rooms to receive a digest, got ${tick1.posted.length}`;
  }
  const roomA = sent.find((s) => s.roomId === ROOM_A);
  const roomB = sent.find((s) => s.roomId === ROOM_B);
  if (!roomA || !roomB) return "expected a digest for room A AND room B";

  if (
    !roomA.text.includes("Refactor auth") ||
    !roomA.text.includes("Add billing page")
  ) {
    return `room A digest is missing one of its tasks:\n${roomA.text}`;
  }
  if (roomA.text.includes("Fix flaky CI")) {
    return `room A digest leaked room B's task (isolation broken):\n${roomA.text}`;
  }
  if (sent.some((s) => s.text.includes("Ship landing page"))) {
    return "a terminal (done) task surfaced in a live digest";
  }
  if (sent.some((s) => s.text.includes("Background reindex"))) {
    return "a chat-less (null-origin) task surfaced in a digest";
  }
  if (!roomA.text.startsWith("📡 Task update — 2 active")) {
    return `room A digest header should report 2 active tasks:\n${roomA.text}`;
  }

  // --- Tick 2: unchanged state → both rooms deduped (no re-post). ---
  const before = sent.length;
  const tick2 = await runSupervisorTick(multiTaskViews(), send, seen);
  if (tick2.posted.length !== 0 || tick2.skipped.length !== 2) {
    return `unchanged tick should dedup both rooms, got posted=${tick2.posted.length} skipped=${tick2.skipped.length}`;
  }
  if (sent.length !== before)
    return "dedup tick should not send any new digest";

  // --- Tick 3: room A loses a task → A re-posts, B still deduped. ---
  const fewer = multiTaskViews().filter((v) => v.id !== "t-a2");
  const tick3 = await runSupervisorTick(fewer, send, seen);
  if (!tick3.posted.includes(ROOM_A) || !tick3.skipped.includes(ROOM_B)) {
    return `changed room A should re-post while room B dedups, got ${JSON.stringify(tick3)}`;
  }
  if (sent.at(-1)?.text.includes("Add billing page")) {
    return "re-posted room A digest still lists the removed task";
  }

  // Sanity: the pure composer is stable and sorted by label.
  const digest = composeRoomDigest(
    multiTaskViews().filter(
      (v) => v.origin?.roomId === ROOM_A && v.status !== "done",
    ),
  );
  if (digest.indexOf("Add billing page") > digest.indexOf("Refactor auth")) {
    return "digest lines should be sorted by label";
  }
  return undefined;
}
