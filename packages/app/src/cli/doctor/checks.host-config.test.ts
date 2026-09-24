/**
 * `checkHostConfig` is the doctor preflight that warns an operator when the
 * agent's HTTP API is bound somewhere reachable without a stable token (#8801 —
 * shipped untested). If it stops warning, someone exposes the API on all
 * interfaces with an auto-rotating token and never finds out, so each
 * exposed-vs-safe branch is pinned. It reads only the injected env, so no global
 * state is touched.
 */
import { describe, expect, it } from "vitest";
import { checkHostConfig } from "./checks.ts";

describe("checkHostConfig", () => {
  it("passes for the default loopback bind", () => {
    const r = checkHostConfig({});
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/loopback only/i);
  });

  it("WARNS on a wildcard (0.0.0.0) bind with no token", () => {
    const r = checkHostConfig({ ELIZA_API_BIND: "0.0.0.0" });
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/auto-generated each restart/i);
  });

  it("passes a wildcard bind once a stable token is set", () => {
    const r = checkHostConfig({
      ELIZA_API_BIND: "0.0.0.0",
      ELIZA_API_TOKEN: "stable-secret",
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/token protected/i);
  });

  it("WARNS on a non-loopback bind with no token", () => {
    const r = checkHostConfig({ ELIZA_API_BIND: "192.168.1.50" });
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/without ELIZA_API_TOKEN/i);
  });

  it("passes a non-loopback bind once a token is set", () => {
    const r = checkHostConfig({
      ELIZA_API_BIND: "192.168.1.50",
      ELIZA_API_TOKEN: "stable-secret",
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/token protected/i);
  });

  it("passes when an explicit allowed-hosts list is configured", () => {
    const r = checkHostConfig({ ELIZA_ALLOWED_HOSTS: "app.example" });
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/ELIZA_ALLOWED_HOSTS=app\.example/);
  });
});
