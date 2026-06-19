import { describe, expect, it } from "vitest";
import {
  isLoopbackBindHost,
  isWildcardBindHost,
  resolveApiSecurityConfig,
  stripOptionalHostPort,
} from "./runtime-env";

describe("runtime env host security helpers", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "localhost",
    "::1",
    "[::1]:31337",
    "http://127.0.0.1:31337",
    "::ffff:127.0.0.1",
  ])("treats valid loopback bind hosts as local: %s", (host) => {
    expect(isLoopbackBindHost(host)).toBe(true);
  });

  it.each([
    "127.999.999.999",
    "127.0.0.256",
    "127.foo",
    "127.0.0.1.evil.example",
    "192.168.1.1",
    "example.com",
  ])("does not treat malformed or remote hosts as loopback: %s", (host) => {
    expect(isLoopbackBindHost(host)).toBe(false);
  });

  it("parses URL and bracketed host forms before classifying bind hosts", () => {
    expect(stripOptionalHostPort("https://LOCALHOST:31337/path")).toBe(
      "localhost",
    );
    expect(stripOptionalHostPort("[::1]:31337")).toBe("::1");
    expect(isWildcardBindHost("0.0.0.0:31337")).toBe(true);
  });

  it("resolves API security config without promoting malformed 127.* binds to loopback", () => {
    const config = resolveApiSecurityConfig({
      ELIZA_API_BIND: "127.999.999.999",
      ELIZA_ALLOWED_ORIGINS: " https://app.example, http://localhost:2138 ",
      ELIZA_ALLOWED_HOSTS: " app.example,localhost ",
      ELIZA_ALLOW_NULL_ORIGIN: "true",
      ELIZA_API_TOKEN: "token",
    });

    expect(config).toMatchObject({
      bindHost: "127.999.999.999",
      token: "token",
      allowNullOrigin: true,
      isLoopbackBind: false,
      isWildcardBind: false,
    });
    expect(config.allowedOrigins).toEqual([
      "https://app.example",
      "http://localhost:2138",
    ]);
    expect(config.allowedHosts).toEqual(["app.example", "localhost"]);
  });
});
