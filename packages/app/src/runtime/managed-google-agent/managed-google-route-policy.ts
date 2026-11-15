export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw Error("Invalid Cloud request");
  return value;
}

/** Admit only the canonical HTTPS origin before a host can send credentials. */
export function assertManagedGoogleApiOrigin(apiOrigin: string): void {
  const origin = URL.parse(apiOrigin);
  if (origin?.protocol !== "https:" || origin.origin !== apiOrigin)
    throw new TypeError("Invalid Cloud API origin");
}
/** Longest Gmail search Cloud admits, including any date clause the host appends. */
export const GMAIL_QUERY_MAX = 2048;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in owner-supplied request fields.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const GOOGLE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Narrow owner-service surface. URL queries carry opaque provider IDs; paths never do. */
export function managedGoogleRequest(
  url: URL,
  method: string,
  body: unknown,
): boolean {
  if (/[\\%]/.test(url.pathname) || url.pathname.includes("//")) return false;
  const prefix = "/api/v1/eliza/google/",
    route = url.pathname.slice(prefix.length);
  if (!url.pathname.startsWith(prefix)) return false;
  if (
    route === "calendar/sync-v1/capabilities" ||
    route === "calendar/sync-v1/event"
  ) {
    const clean = (value: unknown, max = 2048) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !CONTROL_CHARACTERS.test(value);
    let value: Record<string, unknown>;
    if (method === "POST" || method === "PATCH") {
      if (
        url.search ||
        typeof body !== "string" ||
        Buffer.byteLength(body) > 256 * 1024
      )
        return false;
      try {
        value = object(JSON.parse(body));
      } catch {
        return false;
      }
    } else {
      if (
        body !== undefined ||
        new Set(url.searchParams.keys()).size !==
          [...url.searchParams.keys()].length
      )
        return false;
      value = Object.fromEntries(url.searchParams);
    }
    if (
      typeof value.grantId !== "string" ||
      !GOOGLE_UUID.test(value.grantId) ||
      !clean(value.calendarId, 1024)
    )
      return false;
    const keys = Object.keys(value).sort().join();
    if (route.endsWith("/capabilities"))
      return method === "GET" && keys === "calendarId,grantId";
    if (!clean(value.accountId)) return false;
    if (method === "GET")
      return (
        (keys === "accountId,calendarId,eventId,grantId" &&
          clean(value.eventId, 1024)) ||
        (keys === "accountId,calendarId,grantId,idempotencyKey" &&
          clean(value.idempotencyKey))
      );
    if (method === "DELETE")
      return (
        keys === "accountId,calendarId,eventId,expectedEtag,grantId" &&
        clean(value.eventId, 1024) &&
        clean(value.expectedEtag, 1024) &&
        value.expectedEtag !== "*"
      );
    if (
      !value.event ||
      typeof value.event !== "object" ||
      Array.isArray(value.event)
    )
      return false;
    return method === "POST"
      ? keys === "accountId,calendarId,event,grantId,idempotencyKey" &&
          clean(value.idempotencyKey)
      : method === "PATCH" &&
          keys === "accountId,calendarId,event,eventId,expectedEtag,grantId" &&
          clean(value.eventId, 1024) &&
          clean(value.expectedEtag, 1024) &&
          value.expectedEtag !== "*";
  }
  if (method === "POST") {
    if (
      url.search ||
      typeof body !== "string" ||
      Buffer.byteLength(body) > 8 * 1024 * 1024
    )
      return false;
    let value: Record<string, unknown>;
    try {
      value = object(JSON.parse(body));
    } catch {
      return false;
    }
    // Canonical Gmail operations prepare a review before a separate digest-bound
    // dispatch. Preserve that contract; never add a direct provider-send endpoint.
    const prepare = route === "gmail/inbox-v1/operations",
      dispatch =
        /^gmail\/inbox-v1\/operations\/[A-Za-z0-9_-]{1,160}\/dispatch$/.test(
          route,
        );
    if (prepare || dispatch) {
      if (
        typeof value.grantId !== "string" ||
        !GOOGLE_UUID.test(value.grantId) ||
        !isObject(value.proposal) ||
        typeof value.proposal.kind !== "string"
      )
        return false;
      if (
        ![
          "send",
          "draft-create",
          "draft-replace",
          "draft-delete",
          "archive",
          "unarchive",
          "trash",
          "untrash",
          "mark-read",
          "mark-unread",
        ].includes(value.proposal.kind)
      )
        return false;
      if (prepare)
        return (
          Object.keys(value).sort().join() === "grantId,proposal,requestId" &&
          typeof value.requestId === "string" &&
          /^[A-Za-z0-9_-]{1,160}$/.test(value.requestId)
        );
      return (
        Object.keys(value).sort().join() === "grantId,proposal,reviewDigest" &&
        typeof value.reviewDigest === "string" &&
        /^[a-f0-9]{64}$/.test(value.reviewDigest)
      );
    }
    if (body.length > 4096) return false;
    if (value.side !== "owner") return false;
    if (route === "disconnect")
      return (
        Object.keys(value).every((key) =>
          ["side", "connectionId"].includes(key),
        ) &&
        typeof value.connectionId === "string" &&
        GOOGLE_UUID.test(value.connectionId)
      );
    if (
      route !== "connect/initiate" ||
      Object.keys(value).some(
        (key) => !["side", "capabilities"].includes(key),
      ) ||
      !Array.isArray(value.capabilities) ||
      !value.capabilities.length ||
      value.capabilities.length > 7
    )
      return false;
    const allowed = new Set([
      "google.basic_identity",
      "google.gmail.triage",
      "google.gmail.send",
      "google.gmail.drafts",
      "google.gmail.mailbox",
      "google.calendar.read",
      "google.calendar.write",
    ]);
    return (
      new Set(value.capabilities).size === value.capabilities.length &&
      value.capabilities.every(
        (cap: unknown) => typeof cap === "string" && allowed.has(cap),
      ) &&
      value.capabilities.includes("google.basic_identity")
    );
  }
  if (method !== "GET" || body !== undefined) return false;
  const params = url.searchParams,
    keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return false;
  const clean = (key: string, max = 1024) => {
    const value = params.get(key);
    return (
      value !== null &&
      value.length > 0 &&
      value.length <= max &&
      !CONTROL_CHARACTERS.test(value)
    );
  };
  const exact = (allowed: string[]) =>
    keys.every((key) => allowed.includes(key));
  if (route === "accounts" || route === "status")
    return exact(["side"]) && params.get("side") === "owner";
  const grant = params.get("grantId");
  if (!grant || !GOOGLE_UUID.test(grant)) return false;
  if (/^gmail\/inbox-v1\/operations\/[A-Za-z0-9_-]{1,160}$/.test(route))
    return exact(["grantId"]);
  if (route === "calendar/calendars")
    return exact(["side", "grantId"]) && params.get("side") === "owner";
  if (route === "calendar/feed") {
    if (
      !exact([
        "side",
        "grantId",
        "calendarId",
        "timeMin",
        "timeMax",
        "timeZone",
      ]) ||
      params.get("side") !== "owner" ||
      !clean("calendarId") ||
      !clean("timeMin", 64) ||
      !clean("timeMax", 64) ||
      !clean("timeZone", 128)
    )
      return false;
    const start = Date.parse(params.get("timeMin") ?? ""),
      end = Date.parse(params.get("timeMax") ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return false;
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: params.get("timeZone") ?? "",
      }).format();
      return true;
    } catch {
      return false;
    }
  }
  if (route === "gmail/search")
    return (
      exact(["side", "grantId", "query", "maxResults", "pageToken"]) &&
      params.get("side") === "owner" &&
      clean("query", GMAIL_QUERY_MAX) &&
      ["10", "25", "50"].includes(params.get("maxResults") ?? "") &&
      (!params.has("pageToken") || clean("pageToken", 4096))
    );
  if (route === "gmail/read")
    return (
      exact(["side", "grantId", "messageId"]) &&
      params.get("side") === "owner" &&
      clean("messageId")
    );
  if (route === "gmail/inbox-v1/capabilities") return exact(["grantId"]);
  if (route === "gmail/inbox-v1/thread")
    return (
      exact(["grantId", "threadId", "offset", "historyId"]) &&
      clean("threadId") &&
      (!params.has("offset") ||
        (/^\d{1,4}$/.test(params.get("offset") ?? "") && clean("historyId"))) &&
      (!params.has("historyId") || params.has("offset"))
    );
  if (route === "gmail/inbox-v1/attachment")
    return (
      exact(["grantId", "messageId", "partId", "historyId", "opaque"]) &&
      ["messageId", "partId", "historyId"].every((key) => clean(key)) &&
      (!params.has("opaque") || params.get("opaque") === "1")
    );
  if (route === "gmail/inbox-v1/drafts")
    return (
      exact(["grantId", "pageToken"]) &&
      (!params.has("pageToken") || clean("pageToken", 4096))
    );
  if (route === "gmail/inbox-v1/draft")
    return (
      exact(["grantId", "draftId", "content"]) &&
      clean("draftId") &&
      (!params.has("content") || params.get("content") === "1")
    );
  return false;
}
export async function boundedServiceJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Empty Cloud response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024 * 1024) throw Error("Cloud response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Managed services never return authentication material. Refuse accidental exposure.
  const inspect = (item: unknown): void => {
    if (item && typeof item === "object")
      for (const [key, nested] of Object.entries(item)) {
        if (
          /^(?:access_?token|refresh_?token|api_?key|authorization|credentialReference|credentialFile|token|sessionId)$/i.test(
            key,
          )
        )
          throw Error("Unexpected Cloud credential response");
        inspect(nested);
      }
  };
  inspect(value);
  return value;
}
