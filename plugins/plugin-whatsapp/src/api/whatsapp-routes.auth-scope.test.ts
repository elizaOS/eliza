/**
 * GET /api/whatsapp/status `authScope` is auth-dir identity, leftover tax
 * after notifications unreadOnly (#21220). Stock develop mapped every
 * non-exact `lifeops` token onto the platform auth dir.
 */
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleWhatsAppRoute,
  type WhatsAppRouteDeps,
  type WhatsAppRouteState,
} from "./whatsapp-routes.js";

function createHarness(path: string) {
  const chunks: string[] = [];
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: (body?: string) => {
      if (body) chunks.push(body);
    },
  } as unknown as ServerResponse;
  const req = {
    url: path,
    headers: { host: "localhost" },
  } as IncomingMessage;
  const whatsappAuthExists = vi.fn(() => false);
  const state: WhatsAppRouteState = {
    whatsappPairingSessions: new Map(),
    config: {},
    saveConfig: vi.fn(),
    workspaceDir: "/tmp/whatsapp-auth-scope-test",
  };
  const deps: WhatsAppRouteDeps = {
    sanitizeAccountId: (accountId) => accountId,
    whatsappAuthExists,
    whatsappLogout: vi.fn(async () => undefined),
    createWhatsAppPairingSession: vi.fn(),
  };
  return { req, res, state, deps, chunks, whatsappAuthExists };
}

function parsed(chunks: string[]): { error?: string; authScope?: string } {
  return JSON.parse(chunks.join("") || "{}") as {
    error?: string;
    authScope?: string;
  };
}

describe("GET /api/whatsapp/status authScope identity", () => {
  it.each(["/api/whatsapp/status", "/api/whatsapp/status?authScope="])(
    "accepts omitted/empty authScope as the platform auth dir",
    async (path) => {
      const { req, res, state, deps, chunks, whatsappAuthExists } =
        createHarness(path);
      await expect(
        handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps),
      ).resolves.toBe(true);
      expect(res.statusCode).toBe(200);
      expect(parsed(chunks).authScope).toBe("platform");
      expect(whatsappAuthExists).toHaveBeenCalledWith(
        state.workspaceDir,
        "default",
      );
    },
  );

  it.each(["platform", "lifeops"] as const)(
    "accepts authScope=%s as that auth dir",
    async (token) => {
      const { req, res, state, deps, chunks, whatsappAuthExists } =
        createHarness(`/api/whatsapp/status?authScope=${token}`);
      await expect(
        handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps),
      ).resolves.toBe(true);
      expect(res.statusCode).toBe(200);
      expect(parsed(chunks).authScope).toBe(token);
      if (token === "platform") {
        expect(whatsappAuthExists).toHaveBeenCalled();
      } else {
        expect(whatsappAuthExists).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["LIFEOPS", "PLATFORM", "1", "0", "true", "TRUE", "foo", "1e2"])(
    "rejects authScope=%s before auth-dir lookup",
    async (token) => {
      const { req, res, state, deps, chunks, whatsappAuthExists } =
        createHarness(
          `/api/whatsapp/status?authScope=${encodeURIComponent(token)}`,
        );
      await expect(
        handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps),
      ).resolves.toBe(true);
      expect(res.statusCode).toBe(400);
      expect(parsed(chunks)).toEqual({ error: "Invalid authScope" });
      expect(whatsappAuthExists).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/api/whatsapp/status?authScope=lifeops&authScope=lifeops",
    "/api/whatsapp/status?authScope=lifeops&authScope=platform",
    "/api/whatsapp/status?authScope=&authScope=lifeops",
    "/api/whatsapp/status?authScope=foo&authScope=lifeops",
  ])("rejects duplicate authScope values in %s", async (path) => {
    const { req, res, state, deps, chunks, whatsappAuthExists } =
      createHarness(path);
    await expect(
      handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps),
    ).resolves.toBe(true);
    expect(res.statusCode).toBe(400);
    expect(parsed(chunks)).toEqual({ error: "Invalid authScope" });
    expect(whatsappAuthExists).not.toHaveBeenCalled();
  });
});
