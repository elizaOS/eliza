import { afterEach, describe, expect, it } from "vitest";
import {
  buildCorsAllowedPorts,
  getAllowedRemoteOrigins,
  invalidateCorsAllowedPorts,
  isAllowedOrigin,
} from "./server-cors";

describe("server CORS origin allowlist", () => {
  const originalEnv = {
    ELIZA_ALLOWED_ORIGINS: process.env.ELIZA_ALLOWED_ORIGINS,
    ELIZA_API_PORT: process.env.ELIZA_API_PORT,
    ELIZA_UI_PORT: process.env.ELIZA_UI_PORT,
    ELIZA_PORT: process.env.ELIZA_PORT,
    ELIZA_GATEWAY_PORT: process.env.ELIZA_GATEWAY_PORT,
    ELIZA_HOME_PORT: process.env.ELIZA_HOME_PORT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    invalidateCorsAllowedPorts();
  });

  it("allows the packaged Electrobun views scheme used by the desktop renderer", () => {
    expect(isAllowedOrigin("views://")).toBe(true);
  });

  it("continues to reject untrusted custom browser schemes", () => {
    expect(isAllowedOrigin("evil://localhost")).toBe(false);
  });

  it("allows localhost on configured API, Vite UI, single-process UI, gateway, home, and Electrobun dev ports", () => {
    process.env.ELIZA_API_PORT = "43137";
    process.env.ELIZA_UI_PORT = "44056";
    process.env.ELIZA_PORT = "42138";
    process.env.ELIZA_GATEWAY_PORT = "48789";
    process.env.ELIZA_HOME_PORT = "42142";
    invalidateCorsAllowedPorts();

    const ports = buildCorsAllowedPorts();

    for (const port of [
      "43137",
      "44056",
      "42138",
      "48789",
      "42142",
      "5174",
      "5200",
    ]) {
      expect(ports.has(port)).toBe(true);
    }
    expect(isAllowedOrigin("http://localhost:43137")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:44056")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:42138")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:48789")).toBe(true);
    expect(isAllowedOrigin("http://localhost:42142")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5174")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5200")).toBe(true);
  });

  it("normalizes explicit remote origins and rejects public hosts not on the allowlist", () => {
    process.env.ELIZA_ALLOWED_ORIGINS =
      "https://dashboard.example.com/path, http://remote.example.net:8080/";
    invalidateCorsAllowedPorts();

    expect(getAllowedRemoteOrigins()).toEqual(
      new Set([
        "https://dashboard.example.com",
        "http://remote.example.net:8080",
      ]),
    );
    expect(isAllowedOrigin("https://dashboard.example.com/settings")).toBe(
      true,
    );
    expect(isAllowedOrigin("http://remote.example.net:8080/agent")).toBe(true);
    expect(isAllowedOrigin("https://not-allowed.example.com")).toBe(false);
  });

  it("recomputes cached env-derived origins after invalidation", () => {
    process.env.ELIZA_ALLOWED_ORIGINS = "https://first.example.com";
    invalidateCorsAllowedPorts();

    expect(isAllowedOrigin("https://first.example.com")).toBe(true);

    process.env.ELIZA_ALLOWED_ORIGINS = "https://second.example.com";
    expect(isAllowedOrigin("https://second.example.com")).toBe(false);

    invalidateCorsAllowedPorts();
    expect(isAllowedOrigin("https://second.example.com")).toBe(true);
    expect(isAllowedOrigin("https://first.example.com")).toBe(false);
  });

  it("allows native mobile origins and fails closed for malformed URL strings", () => {
    expect(isAllowedOrigin("capacitor://localhost")).toBe(true);
    expect(isAllowedOrigin("ionic://localhost")).toBe(true);
    expect(isAllowedOrigin("https://localhost")).toBe(true);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });

  it("rejects trusted native schemes when the host is not local", () => {
    expect(isAllowedOrigin("capacitor://evil.example")).toBe(false);
    expect(isAllowedOrigin("ionic://evil.example")).toBe(false);
    expect(isAllowedOrigin("app://evil.example")).toBe(false);
    expect(isAllowedOrigin("tauri://evil.example")).toBe(false);
  });
});
