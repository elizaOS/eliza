/** Probes credential redaction across real request capture and nested diagnostic shapes. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type RunningFakeProvider,
  redactProviderDiagnostics,
  startFakeProvider,
} from "../../src/provider-contract";

const running: RunningFakeProvider[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((provider) => provider.stop()));
});

async function providerForCapture(): Promise<RunningFakeProvider> {
  const provider = await startFakeProvider({
    fixtures: [
      {
        id: "capture",
        method: "POST",
        path: "/capture",
        response: { status: 204 },
      },
    ],
  });
  running.push(provider);
  return provider;
}

describe("provider credential redaction", () => {
  test("redacts query and header case/separator variants during request capture", async () => {
    const provider = await providerForCapture();
    const query = new URLSearchParams({
      access_token: "query-access-secret",
      "Code-Verifier": "query-verifier-secret",
      apiKey: "query-api-secret",
      cursor: "visible-cursor",
    });

    await fetch(`${provider.url}/capture?${query}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer header-access-secret",
        "X-API_KEY": "header-api-secret",
        "x-request-id": "visible-request-id",
      },
    });

    expect(provider.requests[0]?.query).toEqual({
      access_token: "<redacted>",
      "Code-Verifier": "<redacted>",
      apiKey: "<redacted>",
      cursor: "visible-cursor",
    });
    expect(provider.requests[0]?.headers.authorization).toBe("<redacted>");
    expect(provider.requests[0]?.headers["x-api_key"]).toBe("<redacted>");
    expect(provider.requests[0]?.headers["x-request-id"]).toBe(
      "visible-request-id",
    );
    expect(JSON.stringify(provider.requests[0])).not.toMatch(/query-|header-/);
  });

  test("redacts URL-encoded authorization material while preserving safe fields", async () => {
    const provider = await providerForCapture();
    await fetch(`${provider.url}/capture`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: "authorization-code-secret",
        code_verifier: "form-verifier-secret",
        "API-KEY": "form-api-secret",
        grant_type: "authorization_code",
      }),
    });

    const captured = new URLSearchParams(provider.requests[0]?.body ?? "");
    expect(Object.fromEntries(captured)).toEqual({
      code: "<redacted>",
      code_verifier: "<redacted>",
      "API-KEY": "<redacted>",
      grant_type: "authorization_code",
    });
    expect(provider.requests[0]?.body).not.toMatch(/-secret/);
  });

  test("redacts JSON values recursively without hiding ordinary metadata", async () => {
    const provider = await providerForCapture();
    await fetch(`${provider.url}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessToken: "json-access-secret",
        nested: {
          CODE_VERIFIER: "json-verifier-secret",
          api_key: "json-api-secret",
          status_code: 202,
        },
      }),
    });

    expect(JSON.parse(provider.requests[0]?.body ?? "null")).toEqual({
      accessToken: "<redacted>",
      nested: {
        CODE_VERIFIER: "<redacted>",
        api_key: "<redacted>",
        status_code: 202,
      },
    });
  });

  test("redacts nested diagnostics and credentials embedded in model/log strings", () => {
    const diagnostic = redactProviderDiagnostics({
      event: "model.request",
      attributes: {
        authorizationCode: "nested-code-secret",
        response: { refresh_token: "nested-refresh-secret" },
      },
      modelLog:
        "POST /callback?ACCESS-TOKEN=log-access-secret&code.verifier=log-verifier-secret api_key=log-api-secret",
      message:
        'provider payload {"client-secret":"log client secret","status_code":401}',
      safe: { model: "gpt-test", status_code: 401 },
    });
    const serialized = JSON.stringify(diagnostic);

    expect(serialized).not.toMatch(/nested-|log-/);
    expect(diagnostic).toEqual({
      event: "model.request",
      attributes: {
        authorizationCode: "<redacted>",
        response: { refresh_token: "<redacted>" },
      },
      modelLog:
        "POST /callback?ACCESS-TOKEN=<redacted>&code.verifier=<redacted> api_key=<redacted>",
      message:
        'provider payload {"client-secret":"<redacted>","status_code":401}',
      safe: { model: "gpt-test", status_code: 401 },
    });
  });
});
