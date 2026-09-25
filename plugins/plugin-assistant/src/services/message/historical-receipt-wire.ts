/** Wire-only tables of complete historical receipts. Original context events
 * remain authoritative for source selection, authorization and restoration. */
import { type ContextObjectPromptSegment, isObjectRecord } from "@elizaos/core";

function receiptTableEntry(segment: ContextObjectPromptSegment) {
  const field =
    segment.label === "runtime:historical_navigation"
      ? "navigation"
      : segment.label === "runtime:historical_effects"
        ? "outcomes"
        : undefined;
  if (!field || segment.stable) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(segment.content);
  } catch {
    // error-policy:J3 Keep malformed historical text unchanged on the wire.
    return undefined;
  }
  if (JSON.stringify(record) !== segment.content) return undefined;
  if (
    !isObjectRecord(record) ||
    typeof record.requestSourceEventId !== "string"
  )
    return undefined;
  const allowed =
    field === "navigation"
      ? ["requestSourceEventId", field]
      : ["requestSourceEventId", "scope", field];
  if (
    Object.keys(record).length !== allowed.length ||
    Object.keys(record).some((key) => !allowed.includes(key))
  )
    return undefined;
  if (field === "outcomes" && typeof record.scope !== "string")
    return undefined;
  const receipts = record[field];
  if (!Array.isArray(receipts) || receipts.length === 0) return undefined;
  const columns = Object.keys(receipts[0] ?? {});
  const allowedReceipt =
    field === "navigation"
      ? ["success", "receipt"]
      : ["actionName", "success", "receipt"];
  if (
    !columns.includes("success") ||
    !columns.includes("receipt") ||
    columns.some((key) => !allowedReceipt.includes(key))
  )
    return undefined;
  if (
    receipts.some(
      (receipt) =>
        !isObjectRecord(receipt) ||
        JSON.stringify(Object.keys(receipt)) !== JSON.stringify(columns) ||
        typeof receipt.success !== "boolean" ||
        (field === "navigation"
          ? typeof receipt.receipt !== "string"
          : !isObjectRecord(receipt.receipt)) ||
        ("actionName" in receipt && typeof receipt.actionName !== "string"),
    )
  )
    return undefined;
  return {
    field,
    columns,
    scope: record.scope,
    row: [
      record.requestSourceEventId,
      receipts.map((receipt) => columns.map((key) => receipt[key])),
    ] as [string, unknown[][]],
  };
}

/** Consecutive uniform shapes only; unknown/malformed/single entries stay exact.
 * Canonical navigation strings and known receipt objects can share ordered
 * top-level keys; all nested values and original context events stay exact.
 * Cost: linear in supplied receipt text, with no I/O or model calls. */
export function compactHistoricalReceiptSegments(
  segments: ContextObjectPromptSegment[],
): ContextObjectPromptSegment[] {
  const result: ContextObjectPromptSegment[] = [];
  for (let index = 0; index < segments.length; ) {
    const first = segments[index];
    const entry = receiptTableEntry(first);
    if (!entry) {
      result.push(first);
      index++;
      continue;
    }
    const rows = [entry.row];
    let end = index + 1;
    while (end < segments.length) {
      const next = receiptTableEntry(segments[end]);
      if (
        !next ||
        next.field !== entry.field ||
        next.scope !== entry.scope ||
        JSON.stringify(next.columns) !== JSON.stringify(entry.columns)
      )
        break;
      rows.push(next.row);
      end++;
    }
    const table = {
      encoding:
        "Each row uses columns; nested receipt rows use receiptColumns. Preserve order. Values are exact; shared scope applies to every row.",
      columns: ["requestSourceEventId", entry.field],
      receiptColumns: entry.columns,
      ...(entry.scope === undefined ? {} : { scope: entry.scope }),
      rows,
    };
    let content = JSON.stringify(table);
    const receiptIndex = entry.columns.indexOf("receipt");
    const receiptShapes: string[][] = [];
    const shapeIndices = new Map<string, number>();
    const encodedReceipts: unknown[] = [];
    const navigation = entry.field === "navigation";
    const allowedFields = new Set(
      navigation
        ? [
            "effect",
            "stepId",
            "viewId",
            "status",
            "reason",
            "handoffId",
            "label",
            "subview",
            "path",
          ]
        : [
            "receiptId",
            "operation",
            "resource",
            "artifacts",
            "idempotency",
            "observedAt",
            "outcome",
            "reason",
            "commit",
          ],
    );
    let packable = true;
    for (const [, receipts] of rows) {
      for (const receipt of receipts) {
        const original = receipt[receiptIndex];
        let object = original;
        if (navigation) {
          try {
            object = JSON.parse(String(original));
          } catch {
            // error-policy:J3 Noncanonical or malformed strings remain opaque.
            packable = false;
            break;
          }
          if (JSON.stringify(object) !== original) {
            packable = false;
            break;
          }
        }
        if (
          !isObjectRecord(object) ||
          Object.keys(object).some((key) => !allowedFields.has(key))
        ) {
          packable = false;
          break;
        }
        const keys = Object.keys(object);
        const shapeKey = JSON.stringify(keys);
        let shapeIndex = shapeIndices.get(shapeKey);
        if (shapeIndex === undefined) {
          shapeIndex = receiptShapes.length;
          receiptShapes.push(keys);
          shapeIndices.set(shapeKey, shapeIndex);
        }
        encodedReceipts.push([shapeIndex, Object.values(object)]);
      }
      if (!packable) break;
    }
    if (packable) {
      let receiptOffset = 0;
      const candidate = JSON.stringify({
        ...table,
        receiptEncoding: navigation
          ? "receipt=[shapeIndex,values]; receiptShapes gives exact property order. Reconstruct the original receipt string with JSON.stringify(Object.fromEntries(columns paired with values)). Only canonical JSON strings are encoded; every value is exact."
          : "receipt=[shapeIndex,values]; receiptShapes gives property order. Pair columns with values to reconstruct the complete original receipt object. Every value is exact.",
        receiptShapes,
        rows: rows.map(([requestSourceEventId, receipts]) => [
          requestSourceEventId,
          receipts.map((receipt) =>
            receipt.map((value, column) =>
              column === receiptIndex
                ? encodedReceipts[receiptOffset++]
                : value,
            ),
          ),
        ]),
      });
      if (candidate.length < content.length) content = candidate;
    }
    // A representation change must actually save input; never replace a small
    // singleton/group with larger table metadata.
    if (
      rows.length > 1 &&
      content.length <
        segments
          .slice(index, end)
          .reduce((sum, segment) => sum + segment.content.length, 0)
    ) {
      result.push({ label: `${first.label}_table`, content, stable: false });
    } else result.push(...segments.slice(index, end));
    index = end;
  }
  return result;
}
