import { describe, expect, it } from "vitest";
import { getRequestCookie } from "./request-cookie.js";

describe("request-cookie", () => {
  it("parses cookie from Request", () => {
    const req = new Request("https://example.com", { headers: { cookie: "a=1; b=2" } });
    expect(getRequestCookie(req, "b")).toBe("2");
    expect(getRequestCookie(req, "a")).toBe("1");
  });

  it("returns null for missing or malformed", () => {
    const req = new Request("https://example.com", { headers: {} });
    expect(getRequestCookie(req, "x")).toBeNull();
    const bad = new Request("https://example.com", { headers: { cookie: "bad=%ZZ" } });
    expect(getRequestCookie(bad, "bad")).toBeNull();
  });

  it("decodes URI component", () => {
    const req = new Request("https://example.com", { headers: { cookie: "tok=hello%20world" } });
    expect(getRequestCookie(req, "tok")).toBe("hello world");
  });
});
