import { createHmac } from "node:crypto";
import { NativeHostError } from "./errors.mjs";

const TASK_SCAN_PAGE = 500;
// Trusted host adapter only. It reads the existing owner-scoped journal, never
// task text, connector payloads, payment values, input contents or credentials.
export function createTaskTraceCapture({
  db,
  tasks,
  owner,
  queue,
  participantId,
  deviceId,
  pseudonymKey,
  captureState,
  isCurrentOwner = () => true,
}) {
  if (
    !Buffer.isBuffer(pseudonymKey) ||
    pseudonymKey.length !== 32 ||
    typeof captureState !== "function" ||
    ![participantId, deviceId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v),
    )
  )
    throw new NativeHostError("Invalid pilot task capture binding");
  const ownerKey = JSON.stringify([
    owner.agentId,
    owner.actorId,
    owner.connector.source,
    owner.connector.accountId,
  ]);
  const pseudonym = (...values) =>
    createHmac("sha256", pseudonymKey)
      .update(JSON.stringify([ownerKey, ...values]))
      .digest("hex");
  let busy = false;
  return {
    async collect() {
      if (busy) return { busy: true };
      busy = true;
      try {
        const consent = await captureState();
        if (!isCurrentOwner())
          throw new NativeHostError("Pilot task owner changed");
        if (
          !consent ||
          consent.participantId !== participantId ||
          consent.deviceId !== deviceId ||
          !["active", "paused", "withdrawn"].includes(consent.status) ||
          !Number.isSafeInteger(consent.authorizedAt) ||
          !Array.isArray(consent.changes)
        )
          throw new NativeHostError("Pilot capture authorization unavailable");
        if (consent.status === "withdrawn") {
          queue.withdraw();
          return { withdrawn: true };
        }
        const changes = [
          { at: consent.authorizedAt, status: "active" },
          ...consent.changes,
        ];
        if (
          changes.some(
            (c, i) =>
              !Number.isSafeInteger(c.at) ||
              !["active", "paused", "withdrawn"].includes(c.status) ||
              (i > 0 && c.at < changes[i - 1].at),
          )
        )
          throw new NativeHostError("Pilot capture history unavailable");
        const allowedAt = (at) => {
          if (
            consent.omittedControlCount &&
            at < (consent.changes[0]?.at ?? Infinity)
          )
            return false;
          return changes.filter((c) => c.at <= at).at(-1)?.status === "active";
        };
        // The journal keeps every task the owner ever ran, so scan it in id
        // pages rather than refusing an owner with many tasks. Per-task
        // checkpoints make re-reading an already captured task a no-op.
        const taskPage = db.prepare(
          "SELECT id FROM interactive_task_journal_v1 WHERE owner_key=? AND id>? ORDER BY id LIMIT ?",
        );
        let captured = 0,
          excluded = 0,
          budget = 5000;
        for (let afterId = ""; ; ) {
          const rows = taskPage.all(ownerKey, afterId, TASK_SCAN_PAGE);
          for (const row of rows) {
            const sourceId = pseudonym("source", row.id),
              taskId = pseudonym("task", row.id),
              sessionId = pseudonym("session", row.id);
            let cursor = queue.checkpoint(sourceId);
            for (;;) {
              if (!isCurrentOwner())
                throw new NativeHostError("Pilot task owner changed");
              const page = tasks.events(row.id, owner, cursor);
              if (
                !Array.isArray(page.events) ||
                (page.hasMore && page.events.length === 0) ||
                !Number.isSafeInteger(page.cursor) ||
                page.cursor < cursor ||
                (page.hasMore && page.cursor === cursor)
              )
                throw new NativeHostError("Pilot task journal unavailable");
              for (const entry of page.events) {
                if (--budget < 0) return { captured, excluded, hasMore: true };
                if (
                  !Number.isSafeInteger(entry.sequence) ||
                  entry.sequence <= cursor ||
                  !Number.isSafeInteger(entry.at) ||
                  entry.at < 0
                )
                  throw new NativeHostError(
                    "Pilot task journal ordering unavailable",
                  );
                if (allowedAt(entry.at) && consent.status === "active") {
                  const status =
                    {
                      create: "started",
                      pause: "paused",
                      resume: "resumed",
                      cancel: "cancelled",
                      complete: "completed",
                    }[entry.kind] ?? "unknown";
                  queue.append({
                    eventId: pseudonym("event", row.id, entry.sequence),
                    participantId,
                    deviceId,
                    sessionId,
                    taskId,
                    requestId: null,
                    sequence: entry.sequence + 1,
                    at: entry.at,
                    monotonicMs: null,
                    kind: entry.kind === "checkpoint" ? "gap" : "task",
                    status: entry.kind === "checkpoint" ? "missing" : status,
                    durationMs: null,
                    redacted: ["content"],
                    unavailable: [
                      "screen",
                      "audio",
                      "dom",
                      "model-content",
                      "speech-content",
                      "os",
                    ],
                  });
                  captured++;
                } else excluded++;
                // Append precedes checkpoint. Crash/restart may retry the exact event ID,
                // which is deduplicated locally and by the durable collector.
                queue.checkpoint(sourceId, entry.sequence);
                cursor = entry.sequence;
              }
              if (!page.hasMore) break;
            }
          }
          if (rows.length < TASK_SCAN_PAGE) break;
          afterId = rows.at(-1).id;
        }
        return { captured, excluded, hasMore: false };
      } finally {
        busy = false;
      }
    },
  };
}
