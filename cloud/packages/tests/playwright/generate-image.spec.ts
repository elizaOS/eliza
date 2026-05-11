import { type APIRequestContext, type APIResponse, expect, test } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const CLOUD_URL = process.env.CLOUD_URL ?? process.env.PLAYWRIGHT_API_URL ?? BASE_URL;

type JsonBody = Record<string, unknown>;

async function callGenerateImage(
  request: APIRequestContext,
  method: string,
  data?: JsonBody,
  headers?: Record<string, string>,
): Promise<APIResponse> {
  return request.fetch(`${CLOUD_URL}/api/v1/generate-image`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    data,
  });
}

async function expectAuthError(response: APIResponse): Promise<void> {
  expect([401, 403]).toContain(response.status());
  const body = (await response.json()) as {
    success?: boolean;
    error?: string;
    code?: string;
  };
  expect(body.success).toBe(false);
  expect(body.code).toMatch(/authentication_required|access_denied/);
}

test.describe("Image Generation API - /api/v1/generate-image", () => {
  test("POST is protected by auth and no longer returns the sidecar stub", async ({ request }) => {
    const response = await callGenerateImage(request, "POST", {
      prompt: "A simple red circle",
    });

    expect(response.status()).not.toBe(501);
    await expectAuthError(response);
  });

  test("malformed generation payloads hit the live route after API-key auth", async ({
    request,
  }) => {
    const response = await callGenerateImage(
      request,
      "POST",
      {},
      {
        Authorization: "Bearer eliza_invalid",
      },
    );

    expect(response.status()).not.toBe(501);
    await expectAuthError(response);
  });

  test("unsupported HTTP methods return method errors instead of the sidecar stub", async ({
    request,
  }) => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const response = await callGenerateImage(
        request,
        method,
        {
          prompt: "route coverage",
        },
        {
          Authorization: "Bearer eliza_invalid",
        },
      );
      expect(response.status()).toBe(405);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("Method not allowed");
    }
  });

  test("OPTIONS preflight completes without route auth", async ({ request }) => {
    const response = await request.fetch(`${CLOUD_URL}/api/v1/generate-image`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(response.status()).toBe(204);
    expect(await response.text()).toBe("");
  });
});
