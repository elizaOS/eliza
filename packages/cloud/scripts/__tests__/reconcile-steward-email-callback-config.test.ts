/**
 * Steward callback reconciliation tests exercise the HTTP mutation and
 * readback contract with a deterministic in-process transport.
 */
import { describe, expect, test } from "bun:test";
import { reconcileStewardEmailCallbackConfig } from "../reconcile-steward-email-callback-config.mjs";

const URL =
  "https://steward.example.test/platform/tenants/elizacloud-staging/email-config";

describe("Steward email callback reconciliation", () => {
  test("patches only callback fields and reads back the canonical config", async () => {
    const requests: Request[] = [];
    let config = {
      magicLinkBaseUrl: "https://staging.eliza.app",
      magicLinkCallbackPath: "/auth/callback/email",
      templateId: "eliza",
      hasApiKey: true,
    };
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      const request = new Request(input, init);
      requests.push(request.clone());
      if (request.method === "PATCH") {
        config = { ...config, ...(await request.json()) };
        return Response.json({ ok: true, data: { hasApiKey: true } });
      }
      return Response.json({ ok: true, data: { emailConfig: config } });
    };

    await expect(
      reconcileStewardEmailCallbackConfig({
        environment: "staging",
        stewardApiUrl: "https://steward.example.test",
        tenantId: "elizacloud-staging",
        platformKey: "platform-secret",
        fetchImpl,
      }),
    ).resolves.toEqual({
      environment: "staging",
      callbackUrl: "https://cloud-staging.eliza.app/auth/callback/email",
    });

    expect(
      requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual([`GET ${URL}`, `PATCH ${URL}`, `GET ${URL}`]);
    expect(await requests[1].clone().json()).toEqual({
      magicLinkBaseUrl: "https://cloud-staging.eliza.app",
      magicLinkCallbackPath: "/auth/callback/email",
    });
    expect(
      requests.every(
        (request) =>
          request.headers.get("X-Steward-Platform-Key") === "platform-secret",
      ),
    ).toBe(true);
  });

  test("creates callback fields when the live config is absent", async () => {
    const methods: string[] = [];
    let config: Record<string, unknown> | null = null;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      methods.push(request.method);
      if (request.method === "PATCH") {
        config = await request.json();
        return Response.json({ ok: true, data: { hasApiKey: false } });
      }
      return Response.json({ ok: true, data: { emailConfig: config } });
    };

    await reconcileStewardEmailCallbackConfig({
      environment: "staging",
      stewardApiUrl: "https://steward.example.test",
      tenantId: "elizacloud-staging",
      platformKey: "platform-secret",
      fetchImpl,
    });
    expect(methods).toEqual(["GET", "PATCH", "GET"]);
  });

  test("does not mutate an already canonical config", async () => {
    const methods: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      methods.push(request.method);
      return Response.json({
        ok: true,
        data: {
          emailConfig: {
            magicLinkBaseUrl: "https://cloud-staging.eliza.app",
            magicLinkCallbackPath: "/auth/callback/email",
          },
        },
      });
    };

    await reconcileStewardEmailCallbackConfig({
      environment: "staging",
      stewardApiUrl: "https://steward.example.test",
      tenantId: "elizacloud-staging",
      platformKey: "platform-secret",
      fetchImpl,
    });
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("fails closed when post-patch readback remains stale", async () => {
    const fetchImpl = async () =>
      Response.json({
        ok: true,
        data: {
          emailConfig: {
            magicLinkBaseUrl: "https://staging.eliza.app",
            magicLinkCallbackPath: "/auth/callback/email",
          },
        },
      });
    await expect(
      reconcileStewardEmailCallbackConfig({
        environment: "staging",
        stewardApiUrl: "https://steward.example.test",
        tenantId: "elizacloud-staging",
        platformKey: "platform-secret",
        fetchImpl,
      }),
    ).rejects.toThrow("canonical staging app origin");
  });

  test("rejects unsafe API URLs and production mutation", async () => {
    const base = {
      environment: "staging",
      tenantId: "elizacloud-staging",
      platformKey: "platform-secret",
    };
    await expect(
      reconcileStewardEmailCallbackConfig({
        ...base,
        stewardApiUrl: "http://steward.test",
      }),
    ).rejects.toThrow("absolute HTTPS origin");
    await expect(
      reconcileStewardEmailCallbackConfig({
        ...base,
        environment: "production",
        stewardApiUrl: "https://steward.example.test",
      }),
    ).rejects.toThrow("ENVIRONMENT must be staging");
  });
});
