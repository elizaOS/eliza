/**
 * Coverage for client-env.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getApiBaseUrl } from "./client-env.js";

describe("client-env", () => {
  const orig = process.env.NEXT_PUBLIC_API_URL;
  afterEach(() => {
    if (orig === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = orig;
  });
  it("returns env url on server", () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
    expect(getApiBaseUrl()).toBe("https://api.example.com");
  });
  it("falls back to localhost", () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getApiBaseUrl()).toBe("http://localhost:3000");
  });
});
