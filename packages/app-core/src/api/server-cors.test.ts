import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCorsAllowedPorts,
  getAllowedRemoteOrigins,
  invalidateCorsAllowedPorts,
  isAllowedOrigin,
} from "./server-cors";

describe("server-cors", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "ELIZA_API_PORT",
    "ELIZA_PORT",
    "ELIZA_GATEWAY_PORT",
    "ELIZA_HOME_PORT",
    "ELIZA_ALLOWED_ORIGINS",
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    invalidateCorsAllowedPorts();
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    invalidateCorsAllowedPorts();
  });

  describe("isAllowedOrigin — Capacitor WebView origins", () => {
    it("allows capacitor://localhost", () => {
      expect(isAllowedOrigin("capacitor://localhost")).toBe(true);
    });

    it("allows ionic://localhost", () => {
      expect(isAllowedOrigin("ionic://localhost")).toBe(true);
    });

    it("allows https://localhost", () => {
      expect(isAllowedOrigin("https://localhost")).toBe(true);
    });

    it("allows https://localhost with a path", () => {
      expect(isAllowedOrigin("https://localhost/chat")).toBe(true);
    });
  });

  describe("isAllowedOrigin — ELIZA_ALLOWED_ORIGINS", () => {
    it("allows explicit remote origins from env", () => {
      process.env.ELIZA_ALLOWED_ORIGINS =
        "https://bot.example.com, https://dashboard.example.com";
      expect(isAllowedOrigin("https://bot.example.com")).toBe(true);
      expect(isAllowedOrigin("https://dashboard.example.com")).toBe(true);
    });

    it("rejects origins not in the allow-list", () => {
      process.env.ELIZA_ALLOWED_ORIGINS = "https://bot.example.com";
      expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    });
  });

  describe("isAllowedOrigin — configured local ports", () => {
    it("allows default API port 31337", () => {
      expect(isAllowedOrigin("http://localhost:31337")).toBe(true);
    });

    it("allows default UI port 2138", () => {
      expect(isAllowedOrigin("http://localhost:2138")).toBe(true);
    });

    it("allows Electrobun renderer ports (5174-5200)", () => {
      expect(isAllowedOrigin("http://localhost:5174")).toBe(true);
      expect(isAllowedOrigin("http://localhost:5200")).toBe(true);
    });

    it("rejects localhost on non-configured port", () => {
      expect(isAllowedOrigin("http://localhost:9999")).toBe(false);
    });

    it("allows custom port from ELIZA_API_PORT", () => {
      process.env.ELIZA_API_PORT = "4444";
      expect(isAllowedOrigin("http://localhost:4444")).toBe(true);
    });
  });

  describe("isAllowedOrigin — rejects arbitrary origins", () => {
    it("rejects arbitrary https origins", () => {
      expect(isAllowedOrigin("https://evil.example.com")).toBe(false);
    });

    it("rejects arbitrary http origins", () => {
      expect(isAllowedOrigin("http://attacker.io:31337")).toBe(false);
    });

    it("returns false for invalid URL strings", () => {
      expect(isAllowedOrigin("not-a-url")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isAllowedOrigin("")).toBe(false);
    });
  });

  describe("buildCorsAllowedPorts", () => {
    it("includes Electrobun range 5174-5200", () => {
      const ports = buildCorsAllowedPorts();
      expect(ports.has("5174")).toBe(true);
      expect(ports.has("5200")).toBe(true);
      expect(ports.has("5201")).toBe(false);
    });
  });

  describe("getAllowedRemoteOrigins", () => {
    it("returns empty set when env not set", () => {
      expect(getAllowedRemoteOrigins().size).toBe(0);
    });

    it("parses comma-separated origins", () => {
      process.env.ELIZA_ALLOWED_ORIGINS = "https://a.com, https://b.com";
      const origins = getAllowedRemoteOrigins();
      expect(origins.has("https://a.com")).toBe(true);
      expect(origins.has("https://b.com")).toBe(true);
      expect(origins.size).toBe(2);
    });
  });
});
