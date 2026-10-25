import { createHash, randomUUID } from "node:crypto";
import { gmailSourceLink } from "./bill-source-link.mjs";
import { BillHostError } from "./errors.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = () =>
  Object.assign(
    new BillHostError(
      "Bill selection changed. Review the current sources again.",
    ),
    { code: "BILL_SELECTION_STALE" },
  );
const ownerKey = (owner) =>
  JSON.stringify([
    owner.agentId,
    owner.actorId,
    owner.connector.source,
    owner.connector.accountId,
  ]);
// Equal to BILL_SOURCE_CONFLICT_FIELDS in bill-source-discovery.mjs.
const CONFLICT_FIELDS = ["company", "accountLabel", "origin"];
const text = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 300;
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
function validateCandidate(value, task) {
  const c = structuredClone(value),
    f = c?.facts;
  if (
    !c ||
    !hex(c.billId) ||
    !hex(c.candidateId) ||
    c.sourceRef !== `bill-source:${c.billId}` ||
    !f ||
    !text(f.company) ||
    !text(f.accountLabel) ||
    !task.allowedOrigins.includes(f.origin) ||
    !Number.isSafeInteger(f.amountMinor) ||
    f.amountMinor < 0 ||
    !/^[A-Z]{3}$/.test(f.currency) ||
    !Number.isInteger(f.currencyDigits) ||
    f.currencyDigits < 0 ||
    f.currencyDigits > 4 ||
    (f.dueDate !== undefined && !date(f.dueDate)) ||
    // Offers saved before arrival times were recorded have none.
    (c.receivedAt !== undefined &&
      (typeof c.receivedAt !== "string" ||
        !Number.isFinite(Date.parse(c.receivedAt)) ||
        new Date(c.receivedAt).toISOString() !== c.receivedAt)) ||
    (c.mostRecent !== undefined && c.mostRecent !== true)
  )
    throw fail();
  if (
    new URL(f.origin).origin !== f.origin ||
    new URL(f.origin).protocol !== "https:" ||
    (f.serviceAddress != null && !text(f.serviceAddress)) ||
    (f.servicePeriod != null &&
      (!date(f.servicePeriod.startsOn) ||
        !date(f.servicePeriod.endsOn) ||
        f.servicePeriod.startsOn > f.servicePeriod.endsOn))
  )
    throw fail();
  if (
    Object.keys(c).some(
      (k) =>
        ![
          "billId",
          "candidateId",
          "sourceRef",
          "receivedAt",
          "mostRecent",
          "facts",
          "sources",
        ].includes(k),
    ) ||
    Object.keys(f).some(
      (k) =>
        ![
          "company",
          "origin",
          "accountLabel",
          "amountMinor",
          "currency",
          "currencyDigits",
          "dueDate",
          "serviceAddress",
          "servicePeriod",
        ].includes(k),
    )
  )
    throw fail();
  if (!Array.isArray(c.sources) || !c.sources.length) throw fail();
  for (const source of c.sources) {
    if (
      !source ||
      !["gmail-message", "gmail-attachment"].includes(source.kind) ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(source.messageId) ||
      !hex(source.accountRef) ||
      !hex(source.contentSha256)
    )
      throw fail();
    const fields = [
      "accountRef",
      "contentSha256",
      "kind",
      "messageId",
      ...(source.url !== undefined ? ["threadId", "url"] : []),
      ...(source.kind === "gmail-attachment"
        ? ["partId", "filename", "mimeType"]
        : []),
    ].sort();
    if (Object.keys(source).sort().join(",") !== fields.join(",")) throw fail();
    if (
      source.kind === "gmail-attachment" &&
      (typeof source.partId !== "string" ||
        !/^[0-9.]{0,128}$/.test(source.partId) ||
        typeof source.filename !== "string" ||
        source.filename.length > 1024 ||
        typeof source.mimeType !== "string" ||
        source.mimeType.length > 256)
    )
      throw fail();
  }
  if (
    c.sources.some(
      (s) =>
        (s.url !== undefined || s.threadId !== undefined) &&
        !gmailSourceLink(s.url, s.threadId),
    )
  )
    throw fail();
  if (new Set(c.sources.map((s) => s.accountRef)).size !== 1) throw fail();
  return c;
}
function validateResult(result, task) {
  if (
    !result ||
    ![
      "candidate",
      "ambiguous",
      "missing",
      "incomplete",
      "conflicting-source",
    ].includes(result.status) ||
    !Array.isArray(result.candidates)
  )
    throw fail();
  const candidates = result.candidates.map((c) => validateCandidate(c, task));
  if (result.conflicts !== undefined && !Array.isArray(result.conflicts))
    throw fail();
  // Look-alike messages: only which identity facts differ. Their own
  // company, account and website come from an untrusted email.
  const conflicts = result.conflicts?.map((c) => {
    if (
      !c ||
      Object.keys(c).join(",") !== "differs" ||
      !Array.isArray(c.differs) ||
      !c.differs.length ||
      c.differs.join(",") !==
        CONFLICT_FIELDS.filter((key) => c.differs.includes(key)).join(",")
    )
      throw fail();
    return { differs: [...c.differs] };
  });
  if (
    new Set(candidates.map((c) => c.candidateId)).size !== candidates.length ||
    (result.status === "candidate" && candidates.length !== 1) ||
    (["missing", "incomplete", "conflicting-source"].includes(result.status) &&
      candidates.length !== 0) ||
    (result.status === "conflicting-source" && !conflicts?.length) ||
    (result.unreadable !== undefined &&
      (!Number.isSafeInteger(result.unreadable) || result.unreadable < 1)) ||
    candidates.filter((c) => c.mostRecent).length > 1 ||
    new Set(conflicts?.map((c) => c.differs.join(","))).size !==
      (conflicts?.length ?? 0) ||
    (result.reason !== undefined &&
      !(
        (result.status === "ambiguous" &&
          result.reason === "conflicting-invoice") ||
        (result.status === "incomplete" &&
          result.reason === "newer-unreadable" &&
          result.unreadable >= 1)
      ))
  )
    throw fail();
  return {
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    candidates,
    ...(result.unreadable ? { unreadable: result.unreadable } : {}),
    ...(conflicts?.length ? { conflicts } : {}),
  };
}
function fingerprint(result) {
  return hash({
    ...result,
    candidates: result.candidates
      .map((c) => ({
        ...c,
        sources: [...c.sources].sort((a, b) =>
          a.messageId.localeCompare(b.messageId),
        ),
      }))
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
  });
}
/** Durable product selection over the existing owner-bound task database. No browser effects. */
export function createBillSourceStore(db, tasks, { now = Date.now } = {}) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS bill_source_offers_v1 (task_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, document TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS bill_source_selections_v1 (task_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, document TEXT NOT NULL)",
  );
  return {
    forTask(runtime, taskId) {
      const key = ownerKey(runtime.owner);
      const owned = () => {
        const task = tasks.get(taskId, runtime.owner);
        if (!task) throw fail();
        return task;
      };
      const read = (table) => {
        owned();
        const row = db
          .prepare(
            `SELECT document FROM ${table} WHERE task_id=? AND owner_key=?`,
          )
          .get(taskId, key);
        return row ? JSON.parse(row.document) : null;
      };
      const load = () => {
        const selected = read("bill_source_selections_v1");
        if (selected) validateCandidate(selected.candidate, owned());
        return selected;
      };
      const editable = (task) => {
        if (
          task.authorization.state !== "active" ||
          !["active", "waiting"].includes(task.status) ||
          task.observation ||
          task.operations.length
        )
          throw fail();
      };
      return {
        load,
        offer(result, expectedRevision) {
          const task = owned();
          editable(task);
          if (task.revision !== expectedRevision || load()) throw fail();
          const checked = validateResult(result, task);
          const offer = {
            ...checked,
            offerId: randomUUID(),
            taskId,
            epoch: task.epoch,
            expectedRevision: task.revision,
            expiresAt: now() + 300000,
          };
          db.prepare(
            "INSERT INTO bill_source_offers_v1 VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET document=excluded.document WHERE owner_key=excluded.owner_key",
          ).run(taskId, key, JSON.stringify(offer));
          if (read("bill_source_offers_v1")?.offerId !== offer.offerId)
            throw fail();
          return offer;
        },
        select({ offerId, candidateId, expectedRevision }, freshResult) {
          db.exec("BEGIN IMMEDIATE");
          try {
            const task = owned(),
              previous = load();
            if (previous) {
              if (
                previous.offerId !== offerId ||
                previous.candidate.candidateId !== candidateId
              )
                throw fail();
              db.exec("COMMIT");
              return previous;
            }
            editable(task);
            const offer = read("bill_source_offers_v1");
            if (
              !offer ||
              offer.offerId !== offerId ||
              offer.epoch !== task.epoch ||
              offer.expectedRevision !== expectedRevision ||
              task.revision !== expectedRevision ||
              offer.expiresAt <= now() ||
              !["candidate", "ambiguous"].includes(offer.status) ||
              offer.reason === "conflicting-invoice"
            )
              throw fail();
            const fresh = validateResult(freshResult, task);
            if (fingerprint(fresh) !== fingerprint(validateResult(offer, task)))
              throw fail();
            const candidate = offer.candidates.find(
              (c) => c.candidateId === candidateId,
            );
            if (!candidate) throw fail();
            const selected = {
              schemaVersion: 1,
              taskId,
              offerId,
              selectedAt: now(),
              candidate: validateCandidate(candidate, task),
            };
            db.prepare(
              "INSERT INTO bill_source_selections_v1 VALUES (?,?,?)",
            ).run(taskId, key, JSON.stringify(selected));
            db.exec("COMMIT");
            return selected;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      };
    },
  };
}
