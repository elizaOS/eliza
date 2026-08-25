/**
 * Coverage for cors-apps.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core/edge", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (a: any) => a,
}));
vi.mock("../utils/logger", () => ({ logger: { debug: () => {} } }));

import { addCorsHeaders, validateOrigin } from "./cors-apps.js";

describe("cors-apps", () => {
  it("validates origin always allowed", async () => {
    const req = new Request("https://example.com", { headers: { origin: "https://evil.com" } });
    const result = await validateOrigin(req);
    expect(result.allowed).toBe(true);
  });
  it("adds cors headers", () => {
    const res = new Response("ok");
    const out = addCorsHeaders(res, "https://example.com");
    expect(out.headers.get("access-control-allow-origin")).toBeTruthy();
  });
});
