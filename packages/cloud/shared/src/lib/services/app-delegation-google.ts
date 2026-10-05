/** Maps supported Google transport operations to explicit delegated capabilities before provider dispatch. */
import type { AppDelegationScope } from "@elizaos/cloud-sdk/app-delegation";
import { AppDelegationError } from "./app-delegation";

export type AppGoogleCapability = Extract<AppDelegationScope, `google.${string}`>;

export function validateAppGoogleRequest(input: { url: string; method: string; body?: string }) {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    // error-policy:J3 malformed transport targets are rejected, never normalized into a supported operation.
    throw new AppDelegationError(403, "APP_GOOGLE_PATH_DENIED", "Unsupported Google operation");
  }
  const method = input.method;
  const path = url.pathname;
  let capability: AppGoogleCapability | null = null;
  if (
    method === "GET" &&
    url.origin === "https://openidconnect.googleapis.com" &&
    path === "/v1/userinfo"
  )
    capability = "google.basic_identity";
  if (url.origin === "https://gmail.googleapis.com") {
    if (
      method === "GET" &&
      /^\/gmail\/v1\/users\/me\/(?:profile|messages(?:\/[A-Za-z0-9_-]+)?|history)$/.test(path)
    )
      capability = "google.gmail.triage";
    if (method === "POST" && path === "/gmail/v1/users/me/messages/send")
      capability = "google.gmail.send";
  }
  if (url.origin === "https://www.googleapis.com") {
    if (
      method === "GET" &&
      /^\/calendar\/v3\/(?:users\/me\/calendarList|calendars\/[^/]+\/events(?:\/[^/]+)?)$/.test(
        path,
      )
    )
      capability = "google.calendar.read";
    if (
      (method === "POST" && /^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(path)) ||
      ((method === "PATCH" || method === "DELETE") &&
        /^\/calendar\/v3\/calendars\/[^/]+\/events\/[^/]+$/.test(path))
    )
      capability = "google.calendar.write";
  }
  if (
    !capability ||
    url.username ||
    url.password ||
    url.hash ||
    /%2f|%5c|%2e/i.test(path) ||
    ["access_token", "oauth_token", "key"].some((key) => url.searchParams.has(key))
  )
    throw new AppDelegationError(403, "APP_GOOGLE_PATH_DENIED", "Unsupported Google operation");
  if (method === "GET" && input.body !== undefined)
    throw new AppDelegationError(
      400,
      "APP_GOOGLE_BODY_DENIED",
      "Read requests cannot include a body",
    );
  return { url: url.href, method, body: input.body, capability };
}
