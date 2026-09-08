/** Constrains delegated Google transport to the mail and calendar operations Outreachr implements. */
import { OutreachrDelegationError } from "./outreachr-delegation";

export function validateOutreachrGoogleRequest(input: {
  url: string;
  method: string;
  body?: string;
}) {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    // error-policy:J3 malformed external URL is rejected at the delegated transport boundary.
    throw new OutreachrDelegationError(
      403,
      "OUTREACHR_GOOGLE_PATH_DENIED",
      "Unsupported Google operation",
    );
  }
  const method = input.method.toUpperCase();
  const path = url.pathname;
  const gmail = url.origin === "https://gmail.googleapis.com";
  const calendar = url.origin === "https://www.googleapis.com";
  const userInfo = url.origin === "https://openidconnect.googleapis.com" && path === "/v1/userinfo";
  const allowed =
    !url.username &&
    !url.password &&
    !url.hash &&
    ((method === "GET" &&
      (userInfo ||
        (gmail &&
          /^\/gmail\/v1\/users\/me\/(?:profile|messages(?:\/[A-Za-z0-9_-]+)?|history)$/.test(
            path,
          )) ||
        (calendar &&
          /^\/calendar\/v3\/(?:users\/me\/calendarList|calendars\/[^/]+\/events(?:\/[^/]+)?)$/.test(
            path,
          )))) ||
      (method === "POST" && gmail && path === "/gmail/v1/users/me/messages/send") ||
      (method === "POST" && calendar && /^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(path)) ||
      ((method === "PATCH" || method === "DELETE") &&
        calendar &&
        /^\/calendar\/v3\/calendars\/[^/]+\/events\/[^/]+$/.test(path)));
  if (
    !allowed ||
    /%2f|%5c|%2e/i.test(path) ||
    ["access_token", "oauth_token", "key"].some((key) => url.searchParams.has(key)) ||
    input.url.length > 8192 ||
    (input.body?.length ?? 0) > 1_500_000
  ) {
    throw new OutreachrDelegationError(
      403,
      "OUTREACHR_GOOGLE_PATH_DENIED",
      "Unsupported Google operation",
    );
  }
  if (method === "GET" && input.body)
    throw new OutreachrDelegationError(
      403,
      "OUTREACHR_GOOGLE_BODY_DENIED",
      "Read requests cannot include a body",
    );
  return { url: url.href, method, body: input.body };
}
