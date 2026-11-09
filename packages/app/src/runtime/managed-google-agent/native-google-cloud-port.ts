import type { ManagedGoogleAgentPort } from "./managed-google-agent-host.ts";
import {
  type ManagedGoogleFailureStage,
  recordManagedGoogleFailure,
} from "./managed-google-failure-stage.ts";
import {
  assertManagedGoogleApiOrigin,
  boundedServiceJson,
  managedGoogleRequest,
} from "./managed-google-route-policy.ts";

/** Supplied by the native provider admission, never by a tool or renderer. */
export type NativeGoogleBinding = {
  credentialId: string;
  userId: string;
  organizationId: string;
  accountRef: string;
  sessionGeneration: string;
  token: string;
  expiresAt?: number;
};
type RequestInput = Parameters<ManagedGoogleAgentPort["agentRead"]>[0];
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const readPaths = new Set([
  "/api/v1/eliza/google/accounts",
  "/api/v1/eliza/google/gmail/search",
  "/api/v1/eliza/google/gmail/read",
  "/api/v1/eliza/google/calendar/calendars",
  "/api/v1/eliza/google/calendar/feed",
]);

export function createNativeGoogleCloudPort(
  binding: NativeGoogleBinding,
  options: {
    apiOrigin: string;
    userAgent: string;
    assertCurrent: () => void;
    request?: typeof fetch;
  },
): ManagedGoogleAgentPort {
  const { apiOrigin, userAgent, assertCurrent, request = fetch } = options;
  assertManagedGoogleApiOrigin(apiOrigin);
  if (
    ![binding.credentialId, binding.userId, binding.organizationId].every(
      (value) => UUID.test(value),
    ) ||
    typeof binding.sessionGeneration !== "string" ||
    !binding.sessionGeneration ||
    binding.sessionGeneration.length > 256 ||
    typeof binding.token !== "string" ||
    binding.token.length < 8 ||
    binding.token.length > 16384 ||
    /[^\x21-\x7e]/.test(binding.token) ||
    binding.accountRef !==
      JSON.stringify([
        "cloud",
        "production",
        binding.userId,
        binding.organizationId,
      ]) ||
    (binding.expiresAt !== undefined &&
      (!Number.isFinite(binding.expiresAt) || binding.expiresAt <= Date.now()))
  )
    throw Error("Native Google provider binding is unavailable");
  const reference = `native-google-reference:${binding.credentialId}`;
  const credential = {
    credentialReference: reference,
    credentialId: binding.credentialId,
    userId: binding.userId,
    organizationId: binding.organizationId,
    ...(binding.expiresAt === undefined
      ? {}
      : { expiresAt: binding.expiresAt }),
  };
  const current = () => {
    assertCurrent();
    if (binding.expiresAt !== undefined && binding.expiresAt <= Date.now())
      throw Error("Native Google provider binding expired");
  };
  async function call(
    input: RequestInput,
    purpose: "read" | "gmail" | "calendar",
  ) {
    let stage: ManagedGoogleFailureStage = "request-validation";
    try {
      current();
      input.signal.throwIfAborted();
      const url = new URL(input.url),
        body =
          input.body === undefined ? undefined : JSON.stringify(input.body);
      if (
        url.origin !== apiOrigin ||
        url.username ||
        url.password ||
        url.hash ||
        url.port ||
        input.credentialReference !== reference
      )
        throw Error("Native Google request refused");
      const read =
        input.method === "GET" &&
        body === undefined &&
        ((url.pathname === "/api/v1/user" && !url.search) ||
          (readPaths.has(url.pathname) &&
            managedGoogleRequest(url, "GET", undefined)));
      let permitted = read;
      if (
        purpose === "gmail" &&
        /^\/api\/v1\/eliza\/google\/gmail\/inbox-v1\/operations(?:\/[A-Za-z0-9_-]{1,160}(?:\/dispatch)?)?$/.test(
          url.pathname,
        )
      ) {
        permitted = managedGoogleRequest(url, input.method, body);
        if (permitted && input.method === "POST")
          permitted = [
            "send",
            "archive",
            "trash",
            "mark-read",
            "mark-unread",
          ].includes(JSON.parse(body ?? "{}").proposal.kind);
      }
      if (
        purpose === "calendar" &&
        url.pathname.startsWith("/api/v1/eliza/google/calendar/sync-v1/")
      )
        permitted = managedGoogleRequest(url, input.method, body);
      if (!permitted)
        throw Error("Native Google operation is outside this host");
      stage = "fetch";
      const response = await request(url.toString(), {
        method: input.method,
        redirect: "error",
        signal: input.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${binding.token}`,
          "User-Agent": userAgent,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      });
      stage = "response-json";
      const data = await boundedServiceJson(response);
      current();
      input.signal.throwIfAborted();
      return { status: response.status, data };
    } catch (error) {
      recordManagedGoogleFailure(error, stage);
      throw error;
    }
  }
  return {
    async agentCredential() {
      current();
      return { ...credential };
    },
    agentRead: (input) => call(input, "read"),
    agentGmailOperation: (input) => call(input, "gmail"),
    agentCalendarOperation: (input) => call(input, "calendar"),
  };
}
