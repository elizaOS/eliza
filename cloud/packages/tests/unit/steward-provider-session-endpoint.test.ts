import { describe, expect, test } from "bun:test";
import { isLocalhostApiBase } from "@/lib/providers/StewardProvider";

describe("isLocalhostApiBase", () => {
  test("matches http://localhost (no port, no trailing slash)", () => {
    expect(isLocalhostApiBase("http://localhost")).toBe(true);
  });

  test("matches http://localhost:3000", () => {
    expect(isLocalhostApiBase("http://localhost:3000")).toBe(true);
  });

  test("matches https://localhost/ (trailing slash)", () => {
    expect(isLocalhostApiBase("https://localhost/")).toBe(true);
  });

  test("matches http://127.0.0.1:8080/api", () => {
    expect(isLocalhostApiBase("http://127.0.0.1:8080/api")).toBe(true);
  });

  test("matches http://0.0.0.0:8080", () => {
    expect(isLocalhostApiBase("http://0.0.0.0:8080")).toBe(true);
  });

  test("matches input with surrounding whitespace (trim)", () => {
    expect(isLocalhostApiBase("   http://localhost   ")).toBe(true);
  });

  test("matches case-insensitively (HTTP, LOCALHOST)", () => {
    expect(isLocalhostApiBase("HTTP://LOCALHOST:3000")).toBe(true);
  });

  test("does NOT match a subdomain-style hostname like http://localhost.foo.com", () => {
    expect(isLocalhostApiBase("http://localhost.foo.com")).toBe(false);
  });

  test("does NOT match a production Eliza Cloud API host", () => {
    expect(isLocalhostApiBase("https://api.elizacloud.ai")).toBe(false);
  });

  test("does NOT match the empty string", () => {
    expect(isLocalhostApiBase("")).toBe(false);
  });

  test("does NOT match a non-http(s) scheme like ws://localhost", () => {
    expect(isLocalhostApiBase("ws://localhost:3000")).toBe(false);
  });

  test("does NOT match an IP that merely starts with 127.0.0.1 as a label", () => {
    // 127.0.0.10 starts with the literal 127.0.0.1 prefix but is a different
    // address; the regex requires the next char to be ':' '/' or end-of-string.
    expect(isLocalhostApiBase("http://127.0.0.10")).toBe(false);
  });
});
