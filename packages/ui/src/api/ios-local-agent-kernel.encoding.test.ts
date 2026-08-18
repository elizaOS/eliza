/**
 * iOS local-agent kernel path encoding leftover-tax after #21362.
 * Stock develop called decodeURIComponent on raw `url.pathname` segments
 * (`GET /api/transcripts/:id` and siblings) with no try/catch, so `%ZZ`
 * threw URIError (unhandled 500) instead of a typed 400. List routes stay
 * untouched. Not extra-decode after URLSearchParams / search/hash.
 */
import { describe, expect, it } from "vitest";
import { handleIosLocalAgentRequest } from "./ios-local-agent-kernel";

describe("iOS local-agent kernel path encoding", () => {
  it("GET /api/transcripts list is untouched", async () => {
    const response = await handleIosLocalAgentRequest(
      new Request("http://127.0.0.1:31337/api/transcripts"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ transcripts: [] });
  });

  it("GET /api/transcripts/%ZZ is 400 not URIError", async () => {
    const response = await handleIosLocalAgentRequest(
      new Request("http://127.0.0.1:31337/api/transcripts/%ZZ"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "malformed URL encoding",
    });
  });
});
