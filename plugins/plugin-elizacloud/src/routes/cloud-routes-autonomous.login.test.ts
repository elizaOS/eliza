/** Exercises the local Cloud login proxy against authoritative upstream session responses. */

import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../cloud/validate-url.js", () => ({
  validateCloudBaseUrl: async () => null,
}));

import {
  type CloudRouteState,
  handleCloudRoute,
} from "./cloud-routes-autonomous.js";

const SERVER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

function responseSink(): http.ServerResponse & { jsonBody: () => unknown } {
  let body = "";
  const sink = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: unknown) => {
      body = typeof chunk === "string" ? chunk : String(chunk ?? "");
      sink.headersSent = true;
      return sink;
    },
    jsonBody: () => JSON.parse(body),
  };
  return sink as unknown as http.ServerResponse & { jsonBody: () => unknown };
}

function state(): CloudRouteState {
  return {
    config: { cloud: { baseUrl: "https://cloud.example.com" } },
    cloudManager: null,
    runtime: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/cloud/login", () => {
  it("returns the upstream server-minted session and sends no proposed id", async () => {
    let requestBody: BodyInit | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requestBody = init?.body;
        return new Response(JSON.stringify({ sessionId: SERVER_SESSION_ID }), {
          status: 201,
        });
      }),
    );
    const response = responseSink();

    await handleCloudRoute(
      {} as http.IncomingMessage,
      response,
      "/api/cloud/login",
      "POST",
      state(),
    );

    expect(JSON.parse(String(requestBody))).toEqual({
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(response.statusCode).toBe(200);
    expect(response.jsonBody()).toEqual({
      ok: true,
      sessionId: SERVER_SESSION_ID,
      browserUrl: `https://cloud.example.com/auth/cli-login?session=${SERVER_SESSION_ID}`,
    });
  });

  it.each([{}, { sessionId: "client-chosen" }])(
    "returns 502 for an invalid upstream session: %j",
    async (payload) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify(payload), { status: 201 }),
        ),
      );
      const response = responseSink();

      await handleCloudRoute(
        {} as http.IncomingMessage,
        response,
        "/api/cloud/login",
        "POST",
        state(),
      );

      expect(response.statusCode).toBe(502);
      expect(response.jsonBody()).toEqual({
        error: "Eliza Cloud returned an invalid login session",
      });
    },
  );
});
