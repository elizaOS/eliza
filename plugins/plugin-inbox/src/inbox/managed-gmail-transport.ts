/** Authenticated bounded loopback transport; the host owns allowed operations. */
import { ElizaError } from "@elizaos/core";

const MAX_BYTES = 256 * 1024;
const failure = (message: string) =>
  new ElizaError(message, { code: "MANAGED_GMAIL_HOST_UNAVAILABLE" });
export function managedGmailHostTransport(
  endpoint: string | undefined,
  token: string | undefined,
  request: typeof fetch = fetch,
) {
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw failure("Invalid managed Gmail host.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/__alpha-owner-gmail" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw failure("Managed Gmail requires its private loopback host.");
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw failure("Managed Gmail host authentication is unavailable.");
  return async (body: object) => {
    const response = await request(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.body) throw failure("The Gmail host returned no result.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES)
          throw failure("The Gmail host response is too large.");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    } catch {
      throw failure("The Gmail host returned an invalid result.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw failure("The Gmail host returned an invalid result.");
    if (!response.ok) {
      if (
        (data as Record<string, unknown>).reason ===
        "provider-route-unavailable"
      )
        throw failure(
          "The Cloud Google operation endpoint is unavailable. This does not mean the Google account is disconnected. Do not request reconnection solely for this error; check the saved receipt before repeating a send.",
        );
      throw failure(
        "The Google request could not be verified. Check its account, permissions, and saved operation receipt; no outcome is confirmed.",
      );
    }
    return data as Record<string, unknown>;
  };
}
