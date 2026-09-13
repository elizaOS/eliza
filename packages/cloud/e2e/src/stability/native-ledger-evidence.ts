/**
 * Validates complete numeric kernel records without rewriting retained bytes.
 * Sequence assignment can precede arrival on another CPU. Correlation therefore
 * uses the sequence index, while the artifact digest covers original arrival order.
 * This validates record completeness, not collector lifetime or signature authority.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core/errors";

interface KernelRecord {
  sequence: number;
  thread: number;
  kind: number;
  nr: number;
  flags: number;
  operation: number;
  monotonicNs: number;
}

function invalid(reason: string): never {
  throw new ElizaError(reason, { code: "STABILITY_NATIVE_LEDGER_INVALID" });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Native numeric evidence is not an object");
  return value as Record<string, unknown>;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    // error-policy:J3 Malformed evidence is rejected without a partial ledger.
    throw new ElizaError("Native evidence is not complete JSON", {
      code: "STABILITY_NATIVE_LEDGER_INVALID",
      cause,
    });
  }
}

const numericFields = [
  "sequence",
  "monotonicNs",
  "thread",
  "socketId",
  "kind",
  "nr",
  "result",
  "family",
  "port",
  "flags",
  "captured",
  "operation",
  "taskStartNs",
  "parentStartNs",
  "parentTgid",
  "namespaceId",
  "namespacePid",
  "parentNamespacePid",
] as const;
const errorCounters = [
  "ringLoss",
  "socketCreateFailure",
  "socketReadFailure",
  "socketDeleteFailure",
  "kernelReadFailure",
  "unsupportedFilterChange",
  "filterStateCreateFailure",
  "filterStateReadFailure",
  "filterStateDeleteFailure",
  "syscallStateCreateFailure",
  "syscallStateReadFailure",
  "syscallStateDeleteFailure",
  "bootstrapRoleFailure",
  "bootstrapNetworkFailure",
] as const;

/** Rejects incomplete, lossy, unknown, or numerically unsupported wire evidence. */
export function validateNativeLedger(bytes: Buffer, counterBytes: Buffer) {
  let text: string;
  let counters: Record<string, unknown>;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    text = decoder.decode(bytes);
    counters = object(parse(decoder.decode(counterBytes)));
  } catch (cause) {
    // error-policy:J2 Preserve the parsing cause; never accept replacement characters.
    throw new ElizaError("Native evidence decoding failed", {
      code: "STABILITY_NATIVE_LEDGER_INVALID",
      cause,
    });
  }
  if (!text.endsWith("\n"))
    invalid("Native ledger has an incomplete terminal record");
  const lines = text.split("\n");
  lines.pop();
  if (!lines.length) invalid("Native ledger is empty");
  const index = new Map<number, KernelRecord>();
  for (const line of lines) {
    const value = object(parse(line));
    if (Object.keys(value).length !== numericFields.length + 1)
      invalid("Native record has an unknown wire shape");
    for (const field of numericFields) {
      const number = value[field];
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        (field !== "result" && number < 0)
      )
        invalid("Native record exceeds the supported exact integer range");
    }
    if (
      !Array.isArray(value.address) ||
      value.address.length !== 4 ||
      value.address.some(
        (word) => !Number.isSafeInteger(word) || word < 0 || word > 0xffffffff,
      )
    )
      invalid("Native record has an invalid numeric address");
    const row = value as unknown as KernelRecord;
    if (
      row.sequence < 1 ||
      row.sequence > lines.length ||
      index.has(row.sequence)
    )
      invalid("Native record sequence is duplicated or incomplete");
    if (row.kind < 1 || row.kind > 25)
      invalid("Native record has an unknown kernel event");
    index.set(row.sequence, row);
  }
  const network = new Map<number, KernelRecord>();
  const filter = new Map<number, KernelRecord>();
  let entries = 0;
  let exits = 0;
  // The index changes traversal only. The caller retains and hashes raw bytes.
  for (let sequence = 1; sequence <= lines.length; sequence++) {
    const row = index.get(sequence);
    if (!row) invalid("Native ledger has a sequence gap");
    const entry = row.kind === 1 || row.kind === 22 || row.kind === 24;
    const exit = row.kind === 2 || row.kind === 25;
    if (!entry && !exit) continue;
    if (!row.thread) invalid("Native syscall has no thread identity");
    const calls = row.kind <= 2 ? network : filter;
    if (entry) {
      if (calls.has(row.thread))
        invalid("Native thread has overlapping syscall entries");
      calls.set(row.thread, row);
      if (row.kind === 1) entries++;
    } else {
      const initial = calls.get(row.thread);
      if (
        !initial ||
        initial.nr !== row.nr ||
        initial.monotonicNs > row.monotonicNs ||
        (row.kind === 25 &&
          (initial.flags !== row.flags || initial.operation !== row.operation))
      )
        invalid("Native syscall result does not match its entry");
      calls.delete(row.thread);
      if (row.kind === 2) exits++;
    }
  }
  if (network.size || filter.size)
    invalid("Native ledger has unfinished syscall outcomes");
  if (
    counters.nativeManifestAuthenticated !== false ||
    counters.emitted !== lines.length ||
    counters.received !== lines.length ||
    counters.syscallEntries !== entries ||
    counters.syscallExits !== exits ||
    entries !== exits
  )
    invalid("Native numeric counters do not match complete records");
  if (
    Object.keys(counters).length !== errorCounters.length + 5 ||
    errorCounters.some((field) => counters[field] !== 0)
  )
    invalid("Native observer reported loss, a fault, or unknown counters");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    records: lines.length,
    syscallEntries: entries,
    syscallExits: exits,
  };
}
