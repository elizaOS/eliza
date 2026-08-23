/**
 * Coverage for request-cookie.
 */
import { describe, expect, it } from "vitest";
import { getRequestCookie } from "./request-cookie.js";
describe("request-cookie", () => {
  it("parses cookie", () => {
    const req = new Request("https://example.com", { headers: { cookie: "a=1; b=2" } });
    expect(getRequestCookie(req, "b")).toBe("2");
  });
  it("returns null missing", () => {
    const req = new Request("https://example.com");
    expect(getRequestCookie(req, "a")).toBeNull();
  });
  it("decodes", () => {
    const req = new Request("https://example.com", { headers: { cookie: "a=hello%20world" } });
    expect(getRequestCookie(req, "a")).toBe("hello world");
  });
  it("handles malformed", () => {
    const req = new Request("https://example.com", { headers: { cookie: "a=%ZZ" } });
    expect(getRequestCookie(req, "a")).toBeNull();
  });
});
