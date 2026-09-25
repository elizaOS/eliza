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
    ],
  };
}

/** Consecutive uniform shapes only; unknown/malformed/single entries stay exact.
 * Nested receipt values are opaque and unchanged, including JSON strings.
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
    const content = JSON.stringify({
      encoding:
        "Each row uses columns; nested receipt rows use receiptColumns. Preserve order. Values are exact; shared scope applies to every row.",
      columns: ["requestSourceEventId", entry.field],
      receiptColumns: entry.columns,
      ...(entry.scope === undefined ? {} : { scope: entry.scope }),
      rows,
    });
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
