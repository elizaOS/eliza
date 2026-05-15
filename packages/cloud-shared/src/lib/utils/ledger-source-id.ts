import crypto from "crypto";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatHashAsUuid(hash: string): string {
  const normalized = hash.slice(0, 32).split("");
  normalized[12] = "5";
  normalized[16] = ["8", "9", "a", "b"][parseInt(normalized[16]!, 16) % 4]!;
  return `${normalized.slice(0, 8).join("")}-${normalized.slice(8, 12).join("")}-${normalized.slice(12, 16).join("")}-${normalized.slice(16, 20).join("")}-${normalized.slice(20, 32).join("")}`;
}

export function normalizeLedgerSourceId(sourceId: string): string {
  const trimmed = sourceId.trim();
  if (UUID_REGEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const hash = crypto.createHash("sha256").update(trimmed).digest("hex");
  return formatHashAsUuid(hash);
}
