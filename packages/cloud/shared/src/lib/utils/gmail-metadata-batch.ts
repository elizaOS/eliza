/** Gmail discovery advertises rootUrl https://gmail.googleapis.com/ + batchPath batch.
 * One HTTP exchange, <=50 quota-counted metadata reads, bounded multipart response. */
export async function readGmailMetadataBatch(
  ids: string[],
  headers: readonly string[],
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  if (
    ids.length < 1 ||
    ids.length > 50 ||
    ids.some((id) => !id || id.length > 256 || id !== id.trim())
  )
    throw Error("Invalid Gmail metadata batch");
  const boundary = "alpha_" + crypto.randomUUID().replaceAll("-", "");
  const query = new URLSearchParams({ format: "metadata" });
  for (const header of headers) query.append("metadataHeaders", header);
  const parts = ids.map(
    (id, index) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <alpha-${index}>\r\n\r\nGET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?${query} HTTP/1.1\r\n\r\n`,
  );
  signal?.throwIfAborted();
  const response = await request("https://gmail.googleapis.com/batch", {
    method: "POST",
    headers: { "Content-Type": `multipart/mixed; boundary=${boundary}`, Accept: "multipart/mixed" },
    body: parts.join("") + `--${boundary}--\r\n`,
    signal,
  });
  if (!response.ok) throw Error("Google Gmail metadata batch failed");
  const contentType = response.headers.get("content-type") || "";
  const marker = /^multipart\/mixed\s*;\s*boundary="?([A-Za-z0-9_-]{1,100})"?\s*$/i.exec(
    contentType,
  )?.[1];
  if (!marker) throw Error("Google Gmail metadata batch has invalid framing");
  const reader = response.body?.getReader();
  if (!reader) throw Error("Google Gmail metadata batch is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2 * 1024 * 1024) throw Error("Google Gmail metadata batch is too large");
      chunks.push(next.value);
    }
  } finally {
    // error-policy:J2 cancellation cleanup must not replace the primary read failure.
    await reader.cancel().catch(() => {});
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes),
    rows = new Map<number, Record<string, unknown>>();
  const sections = text.split(new RegExp(`(?:^|\\r?\\n)--${marker}(?:--)?(?:\\r?\\n|$)`));
  for (const raw of sections) {
    const section = raw.trim();
    if (!section) continue;
    const start = section.indexOf("\r\n\r\n");
    if (start < 0) throw Error("Google Gmail metadata batch is malformed");
    const outer = section.slice(0, start),
      id = /^Content-ID:\s*<response-alpha-(\d+)>\s*$/im.exec(outer)?.[1];
    if (id === undefined || !/^Content-Type:\s*application\/http\s*$/im.test(outer))
      throw Error("Google Gmail metadata batch has an unowned part");
    const index = Number(id);
    if (index >= ids.length || rows.has(index))
      throw Error("Google Gmail metadata batch repeats a part");
    const http = section.slice(start + 4),
      status = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/.exec(http)?.[1],
      body = http.indexOf("\r\n\r\n");
    if (status !== "200" || body < 0) throw Error("Google Gmail metadata batch has a failed part");
    const value: unknown = JSON.parse(http.slice(body + 4));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).id !== ids[index]
    )
      throw Error("Google Gmail metadata batch returned a mismatched message");
    rows.set(index, value as Record<string, unknown>);
  }
  if (rows.size !== ids.length) throw Error("Google Gmail metadata batch is incomplete");
  return ids.map((_, index) => rows.get(index)!);
}
