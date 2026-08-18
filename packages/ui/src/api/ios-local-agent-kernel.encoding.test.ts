/**
 * Verifies that the iOS local-agent kernel rejects malformed encoded path
 * segments without invoking route-specific stores or reporting a server error.
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

  it.each([
    ["transcript", "GET", "/api/transcripts/%ZZ"],
    ["entity memory", "GET", "/api/memories/by-entity/%ZZ"],
    ["browser tab", "GET", "/api/browser-workspace/tabs/%ZZ"],
    ["document fragments", "GET", "/api/documents/%ZZ/fragments"],
    ["model download", "GET", "/api/local-inference/downloads/%ZZ"],
    ["installed model", "GET", "/api/local-inference/installed/%ZZ"],
    ["conversation messages", "GET", "/api/conversations/%ZZ/messages"],
    ["conversation", "DELETE", "/api/conversations/%ZZ"],
  ])("rejects a malformed %s path parameter", async (_name, method, path) => {
    const response = await handleIosLocalAgentRequest(
      new Request(`http://127.0.0.1:31337${path}`, { method }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "malformed URL encoding",
    });
  });
});
