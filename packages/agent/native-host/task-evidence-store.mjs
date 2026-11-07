/** Append-only host evidence, separate from task transitions or effect authority.
 * The synchronous tasks.get must use this connection and must not open its own
 * transaction. Hosts own storage location/encryption and authenticated owners.
 */
import { isDeepStrictEqual } from "node:util";

const envelope = new Set([
  "schemaVersion",
  "taskId",
  "sequence",
  "at",
  "source",
]);
const defaultInvalid = () =>
  Object.assign(new Error("Task evidence unavailable"), {
    code: "TASK_EVIDENCE_INVALID",
  });
export function createTaskEvidenceStore(
  db,
  tasks,
  {
    table,
    source,
    validateInput,
    maxEvents = 500,
    now = Date.now,
    invalid = defaultInvalid,
  },
) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(table) ||
    typeof source !== "string" ||
    !source ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > 10000 ||
    typeof validateInput !== "function"
  )
    throw invalid();
  const name = `"${table}"`;
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${name} (task_id TEXT NOT NULL, owner_key TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(task_id,event_id), UNIQUE(task_id,sequence))`,
  );
  const validate = (value) => {
    const input = validateInput(value);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => envelope.has(key)) ||
      typeof input.eventId !== "string" ||
      !input.eventId ||
      !Number.isSafeInteger(input.expectedEpoch) ||
      input.expectedEpoch < 0
    )
      throw invalid();
    return input;
  };
  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (cause) {
        throw Object.assign(
          new Error("Task evidence rollback failed; discard this connection", {
            cause,
          }),
          { code: "TASK_EVIDENCE_STORAGE_UNCERTAIN" },
        );
      }
      throw error;
    }
  };
  return {
    forTask(owner, taskId) {
      const values = [
        owner?.agentId,
        owner?.actorId,
        owner?.connector?.source,
        owner?.connector?.accountId,
      ];
      if (
        values.some((value) => typeof value !== "string" || !value) ||
        typeof taskId !== "string" ||
        !taskId
      )
        throw invalid();
      const owned = {
        agentId: values[0],
        actorId: values[1],
        connector: { source: values[2], accountId: values[3] },
      };
      const ownerKey = JSON.stringify(values);
      const requireOwned = () => {
        const task = tasks.get(taskId, owned);
        if (!task) throw invalid();
        return task;
      };
      const inputOf = (event) =>
        validate(
          Object.fromEntries(
            Object.entries(event).filter(([key]) => !envelope.has(key)),
          ),
        );
      const read = () => {
        requireOwned();
        const rows = db
          .prepare(
            `SELECT event_id, sequence, document FROM ${name} WHERE task_id=? AND owner_key=? ORDER BY sequence LIMIT ?`,
          )
          .all(taskId, ownerKey, maxEvents + 1);
        if (rows.length > maxEvents) throw invalid();
        return rows.map((row, index) => {
          let event;
          try {
            event = JSON.parse(row.document);
          } catch {
            throw invalid();
          }
          if (!event || typeof event !== "object" || Array.isArray(event))
            throw invalid();
          const input = inputOf(event);
          if (
            event.schemaVersion !== 1 ||
            event.taskId !== taskId ||
            event.source !== source ||
            event.sequence !== index + 1 ||
            row.sequence !== event.sequence ||
            row.event_id !== event.eventId ||
            !Number.isSafeInteger(event.at) ||
            event.at < 0 ||
            Object.keys(event).length !==
              Object.keys(input).length + envelope.size
          )
            throw invalid();
          return event;
        });
      };
      return {
        read: () => transaction(read),
        record(value) {
          const input = validate(value);
          return transaction(() => {
            const task = requireOwned(),
              events = read();
            const previous = events.find(
              (event) => event.eventId === input.eventId,
            );
            if (previous) {
              if (!isDeepStrictEqual(inputOf(previous), input)) throw invalid();
              return previous;
            }
            if (
              input.expectedEpoch !== task.epoch ||
              events.length >= maxEvents
            )
              throw invalid();
            const at = now();
            if (!Number.isSafeInteger(at) || at < 0) throw invalid();
            const event = {
              schemaVersion: 1,
              taskId,
              ...input,
              sequence: events.length + 1,
              at,
              source,
            };
            db.prepare(
              `INSERT INTO ${name}(task_id,owner_key,event_id,sequence,document) VALUES (?,?,?,?,?)`,
            ).run(
              taskId,
              ownerKey,
              event.eventId,
              event.sequence,
              JSON.stringify(event),
            );
            return event;
          });
        },
      };
    },
  };
}
