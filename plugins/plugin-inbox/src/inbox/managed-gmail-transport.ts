/** Authenticated bounded loopback transport; the host owns allowed operations. */
import { ElizaError } from "@elizaos/core";

const MAX_BYTES = 256 * 1024;
const failure = (message: string) =>
  new ElizaError(message, { code: "MANAGED_GMAIL_HOST_UNAVAILABLE" });
const UNCONFIRMED =
  "The Google request could not be verified. Check its account, permissions, and saved operation receipt; no outcome is confirmed.";
const NOT_SENT = "The Gmail host refused this request. Nothing was changed.";
// Closed set of host refusal reasons. Anything else, including no reason,
// keeps the unconfirmed text so a send is never repeated blindly.
const refusals: Readonly<Record<string, string>> = {
  "provider-route-unavailable":
    "The Cloud Google operation endpoint is unavailable. This does not mean the Google account is disconnected. Do not request reconnection solely for this error; check the saved receipt before repeating a send.",
  "signed-out": "Sign in to Eliza Cloud to use Gmail.",
  "no-account": "Gmail isn't connected. Connect it in Settings.",
  "multiple-accounts":
    "More than one Google account has Gmail. Agent Gmail needs one account for now.",
  "permission-needed":
    "Gmail needs permission for this account. Allow it in Settings.",
  "changes-off": "Gmail changes are off in Settings. Nothing was changed.",
  "mailbox-changed": "The mailbox changed. Search again.",
  "invalid-request": NOT_SENT,
  "request-too-large": NOT_SENT,
  "result-too-large":
    "Too much to read at once. Narrow the date range or search.",
  "outcome-unconfirmed": UNCONFIRMED,
};
export function managedGmailHostRefusal(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(refusals, reason)
    ? (refusals[reason] as string)
    : UNCONFIRMED;
}
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
  if (!token || !/^[A-Za-z0-9_-]{64}$/.test(token))
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
    if (!response.ok)
      throw failure(
        managedGmailHostRefusal((data as Record<string, unknown>).reason),
      );
    return data as Record<string, unknown>;
  };
}
