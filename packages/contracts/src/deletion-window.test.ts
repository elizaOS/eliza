import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimDeletion,
  DELETE_UNDO_MS,
  DELETION_NOTICE_TEXT,
  deletionDeadline,
  deletionNotice,
  deletionNoticeSignature,
  deletionReviewRefusal,
  deletionWindow,
  type PendingDeletion,
  pendingDeletionNotices,
  reminderDeletionRefusal,
  rendererDeletionClock,
  undoConfirmed,
} from "./deletion-window.ts";

const clock = (elapsed = 100, wall = 100_000, continuity = "boot:1") => ({
  elapsed,
  wall,
  continuity,
});
const entry = (): PendingDeletion<{ id: string; revision: string }> => ({
  version: 1,
  id: "fixture",
  owner: "owner-A",
  target: { id: "event", revision: "r1" },
  deadline: deletionDeadline(clock()),
  phase: "queued",
});

test("ten seconds on the monotonic clock, including the exact boundary and wall changes", () => {
  assert.equal(DELETE_UNDO_MS, 10_000);
  const deadline = deletionDeadline(clock());
  assert.equal(deadline.expiresAt, 110_000);
  assert.equal(deletionWindow(deadline, clock(10_099, 1)), "open");
  assert.equal(deletionWindow(deadline, clock(10_100, 900_000_000)), "expired");
  assert.equal(deletionWindow(deadline, clock(100, 900_000_000)), "open");
  assert.equal(deletionWindow(deadline, clock(99)), "clock-changed");
  assert.equal(
    deletionWindow(deadline, clock(20_000, 100_000, "boot:2")),
    "clock-changed",
  );
  assert.equal(
    deletionWindow({ ...deadline, expiresElapsed: 1 }, clock(50)),
    "clock-changed",
    "a tampered deadline is not a window",
  );
  assert.throws(() => deletionDeadline(clock(0, -1)));
  assert.throws(() => deletionDeadline(clock(0, 0, "")));
  assert.throws(() => deletionDeadline(clock(0, Number.MAX_SAFE_INTEGER)));
});

test("a persisted target survives restart; Undo and expiry cannot both win or replay dispatch", () => {
  const original = entry();
  const restored = JSON.parse(JSON.stringify(original));
  assert.deepEqual(restored.target, original.target);
  assert.equal(
    claimDeletion(restored, "owner-A", clock(10_100), "dispatch"),
    true,
  );
  assert.equal(restored.phase, "dispatching");
  assert.equal(
    claimDeletion(restored, "owner-A", clock(10_100), "undo"),
    false,
  );
  assert.equal(
    claimDeletion(restored, "owner-A", clock(20_100), "dispatch"),
    false,
  );
  const undone = entry();
  assert.equal(claimDeletion(undone, "owner-A", clock(10_100), "undo"), false);
  assert.equal(claimDeletion(undone, "owner-A", clock(10_099), "undo"), true);
  assert.equal(
    claimDeletion(undone, "owner-A", clock(20_100), "dispatch"),
    false,
  );
});

test("another owner or an unprovable clock cannot dispatch; a pending or paused intent can be cancelled", () => {
  const saved = entry();
  assert.equal(
    claimDeletion(saved, "owner-B", clock(20_100), "dispatch"),
    false,
  );
  assert.equal(
    claimDeletion(
      saved,
      "owner-A",
      clock(20_100, 1, "new-renderer"),
      "dispatch",
    ),
    false,
  );
  assert.equal(saved.phase, "queued");
  assert.equal(
    claimDeletion(saved, "owner-A", clock(20_100, 1, "new-renderer"), "undo"),
    true,
  );
  const paused = { ...entry(), phase: "paused" as const };
  assert.equal(
    claimDeletion(paused, "owner-A", clock(90_000), "dispatch"),
    false,
  );
  assert.equal(claimDeletion(paused, "owner-A", clock(90_000), "undo"), true);
});

test("the renderer clock keeps one continuity per renderer", () => {
  const first = rendererDeletionClock();
  const second = rendererDeletionClock();
  assert.equal(first.continuity, second.continuity);
  assert.ok(second.elapsed >= first.elapsed);
  assert.equal(deletionWindow(deletionDeadline(first), second), "open");
});

test("Undo is confirmed only by an undone receipt", () => {
  assert.equal(undoConfirmed({ phase: "undone" }), true);
  for (const phase of [
    "deleted",
    "conflict",
    "dispatching",
    "unknown",
    "queued",
    "paused",
  ])
    assert.equal(undoConfirmed({ phase }), false, phase);
  assert.equal(undoConfirmed(undefined), false);
  assert.equal(undoConfirmed(null), false);
  assert.equal(undoConfirmed("undone"), false);
});

test("notices offer Undo only while the window is open or paused and never replay an uncertain outcome", () => {
  const row = (phase: string, window?: string) => ({
    id: "a",
    kind: "calendar",
    phase,
    window,
    target: { fields: { title: "Standup" } },
  });
  assert.deepEqual(deletionNotice(row("queued", "open")), {
    key: "calendar:a",
    title: "Standup",
    message: DELETION_NOTICE_TEXT.queued,
    canUndo: true,
    uncertain: false,
  });
  assert.equal(deletionNotice(row("queued", "expired")).canUndo, false);
  assert.equal(
    deletionNotice(row("queued", "expired")).message,
    DELETION_NOTICE_TEXT.verifying,
  );
  assert.equal(deletionNotice(row("queued", "clock-changed")).canUndo, true);
  assert.equal(
    deletionNotice(row("queued", "clock-changed")).message,
    DELETION_NOTICE_TEXT.paused,
  );
  assert.equal(deletionNotice(row("paused")).canUndo, true);
  for (const phase of ["unknown", "dispatching"]) {
    const notice = deletionNotice(row(phase));
    assert.equal(notice.canUndo, false, phase);
    assert.equal(notice.uncertain, true, phase);
    assert.equal(notice.message, DELETION_NOTICE_TEXT.uncertain);
  }
  assert.equal(
    deletionNotice({ id: "r", kind: "reminder", phase: "queued", target: {} })
      .title,
    "Selected reminder",
  );
  assert.equal(
    deletionNotice({
      id: "r",
      kind: "reminder",
      phase: "queued",
      target: { row: { title: "Pills" } },
      original: { title: "Old" },
    }).title,
    "Pills",
  );
  const rows = [
    "queued",
    "paused",
    "unknown",
    "dispatching",
    "deleted",
    "undone",
    "conflict",
  ].map((phase) => row(phase));
  assert.deepEqual(
    pendingDeletionNotices(rows).map((item) => item.phase),
    ["queued", "paused", "unknown", "dispatching"],
  );
  assert.equal(
    deletionNoticeSignature([
      row("queued"),
      { ...row("paused"), kind: "reminder" },
    ]),
    "calendar,a,queued|reminder,a,paused",
  );
});

test("review refusals name only statuses that prove nothing was staged", () => {
  for (const status of ["stale", "unavailable", "not-staged"]) {
    assert.ok(deletionReviewRefusal(status), status);
    assert.ok(reminderDeletionRefusal(status), status);
  }
  for (const status of ["unknown", "queued", "cancelled"]) {
    assert.equal(deletionReviewRefusal(status), undefined, status);
    assert.equal(reminderDeletionRefusal(status), undefined, status);
  }
  assert.match(reminderDeletionRefusal("stale") ?? "", /reminder changed/);
});
