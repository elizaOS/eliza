import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { BillHostError } from "./errors.mjs";

/**
 * Append-only file, independent of the database. An observed outcome is
 * written here before its INSERT, so a failed INSERT or a process exit does
 * not lose the provider reference.
 */
function outcomeJournal(path) {
  const append = (entry) => {
    const fd = openSync(path, "a", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const read = () => {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const entries = [];
    const lines = text.split("\n");
    // An append is acknowledged only after its newline and fsync. Preserve
    // every complete record; only an unfinished final append can be ignored.
    lines.pop();
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        throw new BillHostError("Invalid outcome journal");
      }
    }
    return entries;
  };
  const replace = (entries) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  };
  return { append, read, replace };
}

/** Minimal product outcome records. No page bodies, tokens, or permanent transcripts. */
export function createBillOutcomeStore(db, tasks, { journalPath } = {}) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS bill_outcomes_v1 (task_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, document TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS bill_attempts_v1 (task_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, document TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS bill_reviews_v1 (task_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, document TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS bill_method_selections_v1 (task_id TEXT NOT NULL, operation_id TEXT NOT NULL, owner_key TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(task_id,operation_id))",
  );
  const pending = new Map();
  const pendingAttempts = new Map();
  const journal = journalPath ? outcomeJournal(journalPath) : null;
  const key = (owner) =>
    JSON.stringify([
      owner.agentId,
      owner.actorId,
      owner.connector.source,
      owner.connector.accountId,
    ]);
  // The owner a stored key names, to ask the task store whether its task
  // still exists.
  const ownerOf = (ownerKey) => {
    const value = JSON.parse(ownerKey);
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !value.every((part) => typeof part === "string")
    )
      throw new BillHostError("Invalid outcome owner");
    const [agentId, actorId, source, accountId] = value;
    return { agentId, actorId, connector: { source, accountId } };
  };
  const taskExists = (ownerKey, taskId) =>
    Boolean(tasks.get(taskId, ownerOf(ownerKey)));
  function validateAttempt(record, task) {
    if (
      !record ||
      record.schemaVersion !== 1 ||
      typeof record.attemptId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(record.attemptId) ||
      typeof record.observationId !== "string" ||
      !record.observationId ||
      !Number.isSafeInteger(record.observedAt) ||
      record.observedAt < 0 ||
      typeof record.billSource !== "string" ||
      !record.billSource ||
      record.billSource.length > 512
    )
      throw new BillHostError("Invalid submission record");
    const source = new URL(record.source);
    if (
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      source.search ||
      source.hash ||
      !task.allowedOrigins.includes(source.origin)
    )
      throw new BillHostError("Invalid submission source");
    return record;
  }
  function validateReview(record, task) {
    if (
      !record ||
      !/^[a-f0-9]{64}$/.test(record.reviewKey) ||
      typeof record.documentId !== "string" ||
      !record.documentId ||
      record.documentId.length > 256 ||
      !Number.isSafeInteger(record.epoch) ||
      record.epoch < 0 ||
      !Number.isSafeInteger(record.observedAt) ||
      record.observedAt < 0
    )
      throw new BillHostError("Invalid payment review record");
    const source = new URL(record.source),
      review = record.review;
    if (
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      source.search ||
      source.hash ||
      !task.allowedOrigins.includes(source.origin) ||
      !review ||
      review.source !== source.href ||
      typeof review.billSource !== "string" ||
      !review.billSource ||
      review.billSource.length > 512
    )
      throw new BillHostError("Invalid payment review source");
    if (
      ![review.amountMinor, review.feeMinor, review.totalMinor].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      review.amountMinor + review.feeMinor !== review.totalMinor ||
      !/^[A-Z]{3}$/.test(review.currency) ||
      !Number.isInteger(review.currencyDigits) ||
      review.currencyDigits < 0 ||
      review.currencyDigits > 4 ||
      // Null means the reviewed page did not show a payment date. Do not force
      // hosts to invent one. Omission and malformed dates still fail admission.
      (review.paymentDate !== null &&
        (typeof review.paymentDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(review.paymentDate) ||
          Number.isNaN(Date.parse(`${review.paymentDate}T00:00:00Z`)) ||
          new Date(`${review.paymentDate}T00:00:00Z`)
            .toISOString()
            .slice(0, 10) !== review.paymentDate))
    )
      throw new BillHostError("Invalid payment review values");
    for (const value of [review.company, review.accountLabel, review.method])
      if (typeof value !== "string" || !value || value.length > 300)
        throw new BillHostError("Invalid payment review detail");
    if (/(?:[0-9][ -]?){12,}/.test(review.method))
      throw new BillHostError("Unmasked payment review method");
    return record;
  }
  function validate(record) {
    if (
      !record ||
      record.schemaVersion !== 1 ||
      typeof record.observationId !== "string" ||
      !Number.isSafeInteger(record.observedAt) ||
      record.decision?.kind !== "outcome" ||
      !["paid", "scheduled"].includes(record.decision.status) ||
      typeof record.decision.reference !== "string" ||
      !record.decision.reference.trim() ||
      record.decision.reference.length > 128 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in provider references.
      /[\x00-\x1f\x7f]/.test(record.decision.reference) ||
      typeof record.decision.billSource !== "string" ||
      record.decision.billSource.length > 512 ||
      (record.decision.company != null &&
        (typeof record.decision.company !== "string" ||
          !record.decision.company.trim() ||
          record.decision.company.length > 300))
    )
      throw new BillHostError("Invalid outcome record");
    const d = record.decision;
    if (
      d.totalMinor != null &&
      (!Number.isSafeInteger(d.totalMinor) ||
        d.totalMinor < 0 ||
        !/^[A-Z]{3}$/.test(d.currency) ||
        !Number.isInteger(d.currencyDigits) ||
        d.currencyDigits < 0 ||
        d.currencyDigits > 4)
    )
      throw new BillHostError("Invalid outcome amount");
    if (
      d.paymentDate != null &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(d.paymentDate) ||
        new Date(`${d.paymentDate}T00:00:00Z`).toISOString().slice(0, 10) !==
          d.paymentDate)
    )
      throw new BillHostError("Invalid outcome date");
    const url = new URL(record.decision.source);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new BillHostError("Outcome source must be a canonical HTTPS page");
    return record;
  }
  // Recover outcomes whose INSERT never committed. They are offered again as
  // pending records; nothing is sent to the website.
  if (journal) {
    const unsaved = [];
    for (const entry of journal.read()) {
      if (
        !entry ||
        typeof entry.taskId !== "string" ||
        typeof entry.ownerKey !== "string"
      )
        throw new BillHostError("Invalid outcome journal entry");
      const record = validate(entry.record);
      const row = db
        .prepare(
          "SELECT document FROM bill_outcomes_v1 WHERE task_id=? AND owner_key=?",
        )
        .get(entry.taskId, entry.ownerKey);
      if (row) {
        if (!isDeepStrictEqual(validate(JSON.parse(row.document)), record))
          throw new BillHostError(
            "Outcome journal conflicts with saved record",
          );
        continue;
      }
      // A task that no longer exists (its data was erased) keeps no outcome
      // here, so it never warns a later task about a prior payment.
      if (!taskExists(entry.ownerKey, entry.taskId)) continue;
      pending.set(JSON.stringify([entry.ownerKey, entry.taskId]), record);
      unsaved.push(entry);
    }
    journal.replace(unsaved);
  }
  return {
    latest(owner) {
      const row = db
        .prepare(
          "SELECT task_id, document FROM bill_outcomes_v1 WHERE owner_key=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(key(owner));
      if (!row) return null;
      validate(JSON.parse(row.document));
      return { taskId: row.task_id };
    },
    forTask(runtime, taskId) {
      const owner = runtime.owner,
        ownerKey = key(owner),
        pendingKey = JSON.stringify([ownerKey, taskId]);
      const requireOwned = () => {
        const task = tasks.get(taskId, owner);
        if (!task) throw new BillHostError("Outcome task not owned");
        return task;
      };
      const load = () => {
        requireOwned();
        const memory = pending.get(pendingKey);
        if (memory) return memory;
        const row = db
          .prepare(
            "SELECT document FROM bill_outcomes_v1 WHERE task_id=? AND owner_key=?",
          )
          .get(taskId, ownerKey);
        return row ? validate(JSON.parse(row.document)) : null;
      };
      const finish = (record) => {
        try {
          const task = requireOwned();
          if (
            !task.allowedOrigins.includes(
              new URL(record.decision.source).origin,
            )
          )
            throw new BillHostError("Outcome source changed scope");
          db.prepare(
            "INSERT OR IGNORE INTO bill_outcomes_v1(task_id,owner_key,document) VALUES (?,?,?)",
          ).run(taskId, ownerKey, JSON.stringify(record));
          const saved = db
            .prepare(
              "SELECT document FROM bill_outcomes_v1 WHERE task_id=? AND owner_key=?",
            )
            .get(taskId, ownerKey);
          if (!saved || saved.document !== JSON.stringify(record))
            throw new BillHostError("Outcome record conflict");
          // Persist the verified result before releasing the one-task slot. A
          // crash between these commits is repaired without another browser action.
          if (!["completed", "cancelled"].includes(task.status))
            tasks.transition(
              taskId,
              { owner, expectedRevision: task.revision, now: Date.now() },
              { type: "complete" },
            );
          pending.delete(pendingKey);
          return {
            ...structuredClone(record.decision),
            observedAt: record.observedAt,
            saveStatus: "saved",
          };
        } catch {
          pending.set(pendingKey, record);
          return {
            ...structuredClone(record.decision),
            observedAt: record.observedAt,
            saveStatus: "pending",
            message:
              "The website outcome was observed. Finishing its local record failed. Retry saving the reference; do not submit another payment.",
          };
        }
      };
      // History from other tasks of this owner for this bill. Includes writes
      // awaiting retry.
      const priorPayment = (bill, outcomesOnly) => {
        requireOwned();
        if (
          !bill ||
          typeof bill.sourceRef !== "string" ||
          !bill.sourceRef ||
          new URL(bill.origin).origin !== bill.origin
        )
          throw new BillHostError("Invalid bill identity");
        const matches = (record, outcome = false) => {
          const data = outcome
            ? validate(record).decision
            : validateAttempt(record, {
                allowedOrigins: [new URL(record.source).origin],
              });
          return (
            data.billSource === bill.sourceRef &&
            new URL(data.source).origin === bill.origin
          );
        };
        // Include writes awaiting retry: a new task must not bypass an in-process
        // warning merely because the previous task could not persist its record.
        for (const [entry, record] of outcomesOnly ? [] : pendingAttempts) {
          const [entryOwner, entryTask] = JSON.parse(entry);
          if (
            entryOwner === ownerKey &&
            entryTask !== taskId &&
            matches(record) &&
            taskExists(entryOwner, entryTask)
          )
            return true;
        }
        for (const [entry, record] of pending) {
          const [entryOwner, entryTask] = JSON.parse(entry);
          if (
            entryOwner === ownerKey &&
            entryTask !== taskId &&
            matches(record, true) &&
            taskExists(entryOwner, entryTask)
          )
            return true;
        }
        for (const row of outcomesOnly
          ? []
          : db
              .prepare(
                "SELECT document FROM bill_attempts_v1 WHERE owner_key=? AND task_id<>?",
              )
              .all(ownerKey, taskId)) {
          if (matches(JSON.parse(row.document))) return true;
        }
        for (const row of db
          .prepare(
            "SELECT document FROM bill_outcomes_v1 WHERE owner_key=? AND task_id<>?",
          )
          .all(ownerKey, taskId)) {
          if (matches(JSON.parse(row.document), true)) return true;
        }
        return false;
      };
      return {
        load,
        loadEvidence() {
          requireOwned();
          const row = db
            .prepare(
              "SELECT document FROM bill_outcomes_v1 WHERE task_id=? AND owner_key=?",
            )
            .get(taskId, ownerKey);
          const saved = row ? validate(JSON.parse(row.document)) : null;
          const record = pending.get(pendingKey) ?? saved;
          return {
            record,
            persisted: saved !== null && isDeepStrictEqual(record, saved),
          };
        },
        loadMethodSelection(operationId) {
          const task = requireOwned();
          const row = db
            .prepare(
              "SELECT document FROM bill_method_selections_v1 WHERE task_id=? AND operation_id=? AND owner_key=?",
            )
            .get(taskId, operationId, ownerKey);
          if (!row) return null;
          const record = validateReview(JSON.parse(row.document), task);
          if (
            record.schemaVersion !== 1 ||
            record.operationId !== operationId ||
            record.taskId !== taskId ||
            typeof record.observationId !== "string" ||
            !record.observationId ||
            typeof record.targetRef !== "string" ||
            !record.targetRef ||
            typeof record.authorizationId !== "string" ||
            !record.authorizationId
          )
            throw new BillHostError("Invalid method selection record");
          return record;
        },
        recordMethodSelection(decision, proposal, snapshot) {
          const task = requireOwned();
          if (
            decision.kind !== "choose-existing-method" ||
            task.status !== "active" ||
            task.authorization?.state !== "active" ||
            proposal.authorizationId !== task.authorization.decisionId ||
            proposal.taskId !== taskId ||
            proposal.epoch !== task.epoch ||
            proposal.capability !== "browser.click" ||
            task.observation?.id !== proposal.observationId ||
            task.observation?.version !== proposal.observationVersion ||
            task.observation?.inputRevision !== proposal.inputRevision ||
            !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(proposal.id) ||
            typeof proposal.targetRef !== "string" ||
            !proposal.targetRef ||
            proposal.targetRef.length > 512 ||
            !snapshot.documentId
          )
            throw new BillHostError(
              "Method selection has no current authorization and observation",
            );
          const source = new URL(snapshot.url);
          source.search = "";
          source.hash = "";
          const record = {
            schemaVersion: 1,
            taskId,
            operationId: proposal.id,
            observationId: proposal.observationId,
            targetRef: proposal.targetRef,
            authorizationId: proposal.authorizationId,
            reviewKey: decision.reviewKey,
            documentId: snapshot.documentId,
            epoch: task.epoch,
            observedAt: Date.now(),
            source: source.href,
            review: structuredClone(decision.review),
          };
          record.review.source = source.href;
          validateReview(record, task);
          // Immutable before-dispatch evidence. An existing operation identity cannot
          // be rebound to a new review, including after a crash or a failed dispatch.
          db.prepare(
            "INSERT INTO bill_method_selections_v1 VALUES (?,?,?,?)",
          ).run(taskId, proposal.id, ownerKey, JSON.stringify(record));
          if (
            JSON.stringify(this.loadMethodSelection(proposal.id)) !==
            JSON.stringify(record)
          )
            throw new BillHostError("Method selection record conflict");
          return record;
        },
        loadReview() {
          const task = requireOwned();
          const row = db
            .prepare(
              "SELECT document FROM bill_reviews_v1 WHERE task_id=? AND owner_key=?",
            )
            .get(taskId, ownerKey);
          return row ? validateReview(JSON.parse(row.document), task) : null;
        },
        recordReview(decision, observationId, snapshot, epoch) {
          const task = requireOwned();
          if (
            decision.kind !== "human-submit" ||
            task.observation?.id !== observationId ||
            !snapshot.documentId ||
            !Number.isSafeInteger(epoch) ||
            task.epoch !== epoch
          )
            throw new BillHostError("Review has no current observation");
          const source = new URL(snapshot.url);
          source.search = "";
          source.hash = "";
          if (
            source.protocol !== "https:" ||
            source.username ||
            source.password ||
            !task.allowedOrigins.includes(source.origin)
          )
            throw new BillHostError("Invalid review source");
          const previous = this.loadReview();
          if (previous?.reviewKey === decision.reviewKey) return;
          const record = {
            reviewKey: decision.reviewKey,
            documentId: snapshot.documentId,
            epoch,
            observedAt: Date.now(),
            source: source.href,
            review: structuredClone(decision.review),
          };
          record.review.source = source.href;
          validateReview(record, task);
          db.prepare(
            "INSERT INTO bill_reviews_v1 VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document WHERE owner_key=excluded.owner_key",
          ).run(taskId, ownerKey, JSON.stringify(record));
          if (JSON.stringify(this.loadReview()) !== JSON.stringify(record))
            throw new BillHostError("Payment review record conflict");
        },
        hasPriorPayment(bill) {
          return priorPayment(bill, false);
        },
        /** An earlier task already saved an outcome for this bill. */
        hasPriorOutcome(bill) {
          return priorPayment(bill, true);
        },
        loadAttempt() {
          const task = requireOwned();
          if (pendingAttempts.has(pendingKey))
            return structuredClone(
              validateAttempt(pendingAttempts.get(pendingKey), task),
            );
          const row = db
            .prepare(
              "SELECT document FROM bill_attempts_v1 WHERE task_id=? AND owner_key=?",
            )
            .get(taskId, ownerKey);
          return row ? validateAttempt(JSON.parse(row.document), task) : null;
        },
        recordSubmission(decision, observationId) {
          const task = requireOwned();
          const source = new URL(decision.source);
          if (
            !["submission-pending", "submission-uncertain"].includes(
              decision.kind,
            ) ||
            task.observation?.id !== observationId ||
            source.protocol !== "https:" ||
            source.username ||
            source.password ||
            source.search ||
            source.hash ||
            !task.allowedOrigins.includes(source.origin) ||
            typeof decision.billSource !== "string" ||
            !decision.billSource ||
            decision.billSource.length > 512
          )
            throw new BillHostError(
              "Submission has no current scoped observation",
            );
          const record = this.loadAttempt() || {
            schemaVersion: 1,
            attemptId: randomUUID(),
            observationId,
            observedAt: Date.now(),
            source: source.href,
            billSource: decision.billSource,
            evidenceKind:
              decision.kind === "submission-uncertain"
                ? "manual-activity"
                : "provider-processing",
            review: this.loadReview()?.review ?? null,
          };
          validateAttempt(record, task);
          if (record.billSource !== decision.billSource)
            throw new BillHostError("Submission record conflict");
          // The first observed submission survives retries and process restarts.
          // This is a local identity, not a provider idempotency key.
          pendingAttempts.set(pendingKey, record);
          db.prepare(
            "INSERT OR IGNORE INTO bill_attempts_v1(task_id,owner_key,document) VALUES (?,?,?)",
          ).run(taskId, ownerKey, JSON.stringify(record));
          pendingAttempts.delete(pendingKey);
          const saved = this.loadAttempt();
          if (!saved || saved.billSource !== decision.billSource)
            throw new BillHostError("Submission record conflict");
          return saved;
        },
        retry() {
          const record = load();
          if (!record) throw new BillHostError("No observed outcome to save");
          return finish(record);
        },
        save(decision, observationId) {
          const existing = load();
          if (existing) return finish(existing);
          const task = requireOwned();
          if (
            task.observation?.id !== observationId ||
            task.operations.some((operation) =>
              ["prepared", "dispatched", "unknown"].includes(operation.status),
            )
          )
            throw new BillHostError(
              "Outcome has no current resolved observation",
            );
          const record = validate({
            schemaVersion: 1,
            observationId,
            observedAt: Date.now(),
            decision: {
              kind: "outcome",
              status: decision.status,
              reference: decision.reference,
              source: decision.source,
              billSource: decision.billSource,
              totalMinor: decision.totalMinor ?? null,
              paymentDate: decision.paymentDate ?? null,
              currency: decision.currency ?? null,
              currencyDigits: decision.currencyDigits ?? null,
              company: decision.company ?? null,
            },
          });
          pending.set(pendingKey, record);
          // Journal before the INSERT. If the journal write fails, the outcome
          // stays pending in memory and the person is told to retry saving.
          try {
            journal?.append({ taskId, ownerKey, record });
          } catch {
            return {
              ...structuredClone(record.decision),
              observedAt: record.observedAt,
              saveStatus: "pending",
              message:
                "The website outcome was observed. Finishing its local record failed. Retry saving the reference; do not submit another payment.",
            };
          }
          return finish(record);
        },
      };
    },
  };
}
