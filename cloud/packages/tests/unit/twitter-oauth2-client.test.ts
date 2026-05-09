import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function importOAuth2Client() {
  return import(
    new URL(
      "../../../packages/lib/services/twitter-automation/oauth2-client.ts?test=" +
        `${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

describe("twitter oauth2 client", () => {
  beforeEach(() => {
    mock.restore();
    restoreEnv();
  });

  afterEach(() => {
    mock.restore();
    restoreEnv();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("sends PKCE token exchange as a public client without Authorization", async () => {
    process.env.TWITTER_CLIENT_ID = "client:1:ci";
    delete process.env.TWITTER_CLIENT_SECRET;

    const fetchMock = mock(async () =>
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        scope: "tweet.read users.read offline.access",
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const { requestTwitterOAuth2Token } = await importOAuth2Client();
    const result = await requestTwitterOAuth2Token({
      code: "code-123",
      code_verifier: "verifier-123",
      grant_type: "authorization_code",
      redirect_uri: "https://www.elizacloud.ai/api/v1/twitter/callback",
    });

    expect(result.access_token).toBe("access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.x.com/2/oauth2/token");
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("authorization")).toBeNull();

    const body = init.body as URLSearchParams;
    expect(body.get("client_id")).toBe("client:1:ci");
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("code")).toBe("code-123");
    expect(body.get("code_verifier")).toBe("verifier-123");
    expect(body.get("redirect_uri")).toBe("https://www.elizacloud.ai/api/v1/twitter/callback");
  });

  test("normalizes authorize URLs to X's documented S256 PKCE method", async () => {
    const { normalizeTwitterOAuth2AuthorizeUrl } = await importOAuth2Client();
    const authUrl =
      "https://x.com/i/oauth2/authorize?response_type=code&code_challenge_method=s256&state=abc";

    expect(normalizeTwitterOAuth2AuthorizeUrl(authUrl)).toBe(
      "https://x.com/i/oauth2/authorize?response_type=code&code_challenge_method=S256&state=abc",
    );
  });

  test("sends token exchange for confidential clients with Basic auth instead of body secrets", async () => {
    process.env.TWITTER_CLIENT_ID = "client:1:ci";
    process.env.TWITTER_CLIENT_SECRET = "secret value";

    const fetchMock = mock(async () =>
      Response.json({
        access_token: "access-token",
        scope: "tweet.read users.read",
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const { requestTwitterOAuth2Token } = await importOAuth2Client();
    await requestTwitterOAuth2Token({
      code: "code-123",
      code_verifier: "verifier-123",
      grant_type: "authorization_code",
      redirect_uri: "https://www.elizacloud.ai/api/v1/twitter/callback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const expectedAuthorization = `Basic ${Buffer.from(
      `${encodeURIComponent("client:1:ci")}:${encodeURIComponent("secret value")}`,
    ).toString("base64")}`;

    expect(headers.get("authorization")).toBe(expectedAuthorization);

    const body = init.body as URLSearchParams;
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  test("surfaces upstream token errors with readable detail", async () => {
    process.env.TWITTER_CLIENT_ID = "client:1:ci";
    delete process.env.TWITTER_CLIENT_SECRET;

    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error: "invalid_request",
          error_description: "Value passed for the authorization code was invalid.",
        },
        { status: 400 },
      ),
    ) as typeof fetch;

    const { requestTwitterOAuth2Token } = await importOAuth2Client();

    await expect(
      requestTwitterOAuth2Token({
        code: "code-123",
        code_verifier: "verifier-123",
        grant_type: "authorization_code",
        redirect_uri: "https://www.elizacloud.ai/api/v1/twitter/callback",
      }),
    ).rejects.toThrow("invalid_request: Value passed for the authorization code was invalid.");
  });
});
