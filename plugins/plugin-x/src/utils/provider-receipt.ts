/**
 * Extracts a non-empty provider message identifier from the response shapes
 * returned by twitter-api-v2 without consuming a live Response body in place.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

export function normalizeXReceiptId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.length > 0 ? id : undefined;
}

function extractSynchronousId(result: unknown): string | undefined {
  const paths = [
    ["id"],
    ["data", "id"],
    ["data", "data", "id"],
    ["rest_id"],
    ["data", "create_tweet", "tweet_results", "result", "rest_id"],
    ["data", "create_tweet", "tweet_results", "result", "id"],
    ["data", "data", "create_tweet", "tweet_results", "result", "rest_id"],
    ["data", "data", "create_tweet", "tweet_results", "result", "id"],
  ] as const;

  for (const path of paths) {
    const id = normalizeXReceiptId(readPath(result, path));
    if (id) return id;
  }
  return undefined;
}

export async function extractXWriteReceiptId(
  result: unknown,
): Promise<string | undefined> {
  const direct = extractSynchronousId(result);
  if (direct) return direct;

  const record = asRecord(result);
  if (!record) return undefined;

  let bodySource: unknown = result;
  if (typeof record.clone === "function") {
    if (record.bodyUsed === true) return undefined;
    bodySource = (record.clone as () => unknown)();
  }

  const bodyRecord = asRecord(bodySource);
  if (!bodyRecord || typeof bodyRecord.json !== "function") return undefined;

  try {
    const body = await (bodyRecord.json as () => Promise<unknown>)();
    return extractSynchronousId(body);
  } catch {
    // error-policy:J3 An unreadable provider body is an explicit missing
    // receipt; callers surface a non-retriable indeterminate outcome.
    return undefined;
  }
}
