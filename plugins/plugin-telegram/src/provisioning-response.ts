/**
 * Parsing for the my.telegram.org provisioning endpoints.
 *
 * `sendProvisioningCode` posts to `/auth/send_password` and reads the body as
 * text so it can recognise the plain-text rate-limit notice. Everything else is
 * expected to be JSON, but the endpoint is behind an operator-controlled gateway
 * that answers with an HTML page (or an empty body) when it is rate limited,
 * overloaded, or interrupted — so a bare `JSON.parse` there surfaces as an
 * untyped `SyntaxError` from deep inside connector startup instead of a failure
 * an operator can read. This module keeps both known failure shapes in one
 * place, next to the parsing they describe.
 */
export function parseProvisioningBody(text: string): unknown {
  if (text.includes("Sorry, too many tries")) {
    throw new Error("Telegram provisioning is rate limited right now");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Telegram provisioning returned a non-JSON response");
  }
}
