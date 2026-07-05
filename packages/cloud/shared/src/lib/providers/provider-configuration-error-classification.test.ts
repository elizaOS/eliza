/**
 * Classification contract for isProviderConfigurationError (#13960). Drives the
 * REAL @ai-sdk/gateway client against a local stub upstream so each verdict is
 * asserted on the SDK's genuine error object — not a hand-built fake — for the
 * exact failure shapes seen in prod: a stale key (401 → auth error) and an
 * unreachable/garbled gateway (parse failure → GatewayResponseError). Both must
 * classify as provider-configuration failures so the API boundary returns a
 * clean model-not-available error instead of leaking a raw 500; a genuine
 * caller-fault 400 must NOT.
 */
import { afterAll, expect, test } from "bun:test";
import { generateText, RetryError } from "ai";
import { isProviderConfigurationError } from "./language-model";

async function captureGatewayError(baseURL: string): Promise<{ name: string; error: unknown }> {
  const { createGatewayProvider } = await import("@ai-sdk/gateway");
  const provider = createGatewayProvider({ apiKey: "stale-invalid-key", baseURL });
  try {
    await generateText({
      model: provider.languageModel("some/model"),
      messages: [{ role: "user", content: "hi" }],
    });
    throw new Error("expected the gateway call to throw");
  } catch (error) {
    const unwrapped = RetryError.isInstance(error) ? error.lastError : error;
    return { name: unwrapped instanceof Error ? unwrapped.name : "unknown", error };
  }
}

// A stub that answers 401 with the gateway's schema-valid auth error body — the
// SDK converts it into the contextual GatewayAuthenticationError whose message
// names AI_GATEWAY_API_KEY (the string that leaked in #13406).
const authStub = Bun.serve({
  port: 0,
  fetch: () =>
    Response.json(
      { error: { type: "authentication_error", message: "Invalid API key" } },
      { status: 401 },
    ),
});

// A stub that answers 500 with a body that does NOT match the gateway error
// schema, forcing the SDK's GatewayResponseError ("Invalid error response
// format") — the same shape a garbled/misconfigured gateway produced in
// #13960, which previously leaked as a raw 500.
const garbledStub = Bun.serve({
  port: 0,
  fetch: () => new Response("<html>gateway down</html>", { status: 500 }),
});

afterAll(() => {
  authStub.stop(true);
  garbledStub.stop(true);
});

test("stale gateway key (401 auth error) classifies as provider-configuration", async () => {
  const { name, error } = await captureGatewayError(`http://127.0.0.1:${authStub.port}`);
  expect(name).toBe("GatewayAuthenticationError");
  expect(isProviderConfigurationError(error)).toBe(true);
});

test("unreachable/garbled gateway (unparseable error) classifies as provider-configuration", async () => {
  const { name, error } = await captureGatewayError(`http://127.0.0.1:${garbledStub.port}`);
  // The 5xx body does not match the gateway error schema → GatewayResponseError
  // (or GatewayInternalServerError). Either way it is a deployment-side gateway
  // failure that must NOT leak as a raw 500.
  expect(["GatewayResponseError", "GatewayInternalServerError"]).toContain(name);
  expect(isProviderConfigurationError(error)).toBe(true);
});

test("connection-refused gateway classifies as provider-configuration", async () => {
  // Port 1 is never listening → the fetch throws before any response, driving
  // the SDK's asGatewayError({ response: {} }) → GatewayResponseError path.
  const { error } = await captureGatewayError("http://127.0.0.1:1");
  expect(isProviderConfigurationError(error)).toBe(true);
});

test("a caller-fault 400 is NOT a provider-configuration error", () => {
  // GatewayInvalidRequestError / a plain invalid-request Error is the caller's
  // fault and must fall through to the status-code path (400), never be
  // relabeled "model not available".
  const invalidRequest = Object.assign(new Error("bad request"), {
    name: "GatewayInvalidRequestError",
  });
  expect(isProviderConfigurationError(invalidRequest)).toBe(false);
});

test("a plain runtime error is NOT a provider-configuration error", () => {
  expect(isProviderConfigurationError(new Error("kaboom"))).toBe(false);
  expect(isProviderConfigurationError(new TypeError("x is undefined"))).toBe(false);
});
