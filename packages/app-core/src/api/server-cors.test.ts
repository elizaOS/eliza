/**
 * Unit tests for the server CORS origin allowlist. Verifies the packaged
 * Electrobun `views://` scheme and native mobile schemes are trusted only for
 * local hosts, that localhost is allowed on every env-configured port
 * (API / UI / single-process / gateway / home plus Electrobun dev ports), that
 * explicit `ELIZA_ALLOWED_ORIGINS` remote origins normalize and gate correctly,
 * that the env-derived port cache recomputes after invalidation, and — the
 * security-critical proof for #13422 — that a non-ELIZA brand prefix
 * (`MILADY_*`) resolves the CORS ports/origins through the alias-aware readers
 * WITHOUT materializing the `ELIZA_*` mirror keys, with the canonical `ELIZA_*`
 * key still winning when both are set.
 */

import {
  buildBrandEnvAliases,
  getBootConfig,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

// #13422: the CORS port/origin helpers migrated off raw `process.env.ELIZA_*`
// reads to the alias-aware readers (`resolveDesktopApiPort` / `resolveUiPort`
// for the API/UI ports, `resolveAllowedOrigins` for origins, `readAliasedEnv`
// for the gateway/home ports). A non-ELIZA brand deployment must resolve these
// from its own `<PREFIX>_*` keys without the `syncBrandEnvToEliza` mirror
// mutation, and the canonical `ELIZA_*` key must still win when both are set.
describe("server CORS allowlist — branded alias resolution (#13422)", () => {
  const BRAND = "MILADY";
  const savedConfig = getBootConfig();
  const tracked = [
    "ELIZA_API_PORT",
    "ELIZA_UI_PORT",
    "ELIZA_PORT",
    "ELIZA_GATEWAY_PORT",
    "ELIZA_HOME_PORT",
    "ELIZA_ALLOWED_ORIGINS",
    `${BRAND}_API_PORT`,
    `${BRAND}_UI_PORT`,
    `${BRAND}_PORT`,
    `${BRAND}_GATEWAY_PORT`,
    `${BRAND}_HOME_PORT`,
    `${BRAND}_ALLOWED_ORIGINS`,
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of tracked) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Pin the brand<->eliza alias table on the immutable BootConfig, exactly as
    // the app boot path does for a rebranded distribution.
    setBootConfig({ ...savedConfig, envAliases: buildBrandEnvAliases(BRAND) });
    invalidateCorsAllowedPorts();
  });

  afterEach(() => {
    for (const key of tracked) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    setBootConfig(savedConfig);
    invalidateCorsAllowedPorts();
  });

  it("resolves CORS ports and origins from a non-ELIZA brand prefix", () => {
    process.env[`${BRAND}_API_PORT`] = "43555";
    process.env[`${BRAND}_UI_PORT`] = "44777";
    // The single-process UI port migrated off a raw `process.env.ELIZA_PORT`
    // read to `readAliasedEnv("ELIZA_PORT")` (#13422), so a bare `<PREFIX>_PORT`
    // must now resolve into the CORS port set.
    process.env[`${BRAND}_PORT`] = "42138";
    process.env[`${BRAND}_GATEWAY_PORT`] = "48789";
    process.env[`${BRAND}_HOME_PORT`] = "42142";
    process.env[`${BRAND}_ALLOWED_ORIGINS`] = "https://dashboard.example.com";
    invalidateCorsAllowedPorts();

    const ports = buildCorsAllowedPorts();
    for (const port of ["43555", "44777", "42138", "48789", "42142"]) {
      expect(ports.has(port)).toBe(true);
    }

    expect(getAllowedRemoteOrigins()).toEqual(
      new Set(["https://dashboard.example.com"]),
    );
    expect(isAllowedOrigin("http://localhost:43555")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:42138")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:48789")).toBe(true);
    expect(isAllowedOrigin("https://dashboard.example.com/settings")).toBe(
      true,
    );
  });

  it("does not materialize the ELIZA_* mirror keys while resolving", () => {
    process.env[`${BRAND}_API_PORT`] = "43555";
    process.env[`${BRAND}_UI_PORT`] = "44777";
    process.env[`${BRAND}_PORT`] = "42138";
    process.env[`${BRAND}_GATEWAY_PORT`] = "48789";
    process.env[`${BRAND}_HOME_PORT`] = "42142";
    process.env[`${BRAND}_ALLOWED_ORIGINS`] = "https://dashboard.example.com";
    invalidateCorsAllowedPorts();

    buildCorsAllowedPorts();
    getAllowedRemoteOrigins();

    // Reading must never write the canonical mirror — that is exactly the
    // process.env mutation #13422 removes.
    expect(process.env.ELIZA_API_PORT).toBeUndefined();
    expect(process.env.ELIZA_UI_PORT).toBeUndefined();
    expect(process.env.ELIZA_PORT).toBeUndefined();
    expect(process.env.ELIZA_GATEWAY_PORT).toBeUndefined();
    expect(process.env.ELIZA_HOME_PORT).toBeUndefined();
    expect(process.env.ELIZA_ALLOWED_ORIGINS).toBeUndefined();
  });

  it("keeps the canonical ELIZA_* value ahead of the branded alias", () => {
    process.env.ELIZA_API_PORT = "30000";
    process.env[`${BRAND}_API_PORT`] = "43555";
    process.env.ELIZA_PORT = "20000";
    process.env[`${BRAND}_PORT`] = "42138";
    process.env.ELIZA_GATEWAY_PORT = "18000";
    process.env[`${BRAND}_GATEWAY_PORT`] = "48789";
    process.env.ELIZA_ALLOWED_ORIGINS = "https://canonical.example.com";
    process.env[`${BRAND}_ALLOWED_ORIGINS`] = "https://branded.example.com";
    invalidateCorsAllowedPorts();

    const ports = buildCorsAllowedPorts();
    expect(ports.has("30000")).toBe(true);
    expect(ports.has("43555")).toBe(false);
    expect(ports.has("20000")).toBe(true);
    expect(ports.has("42138")).toBe(false);
    expect(ports.has("18000")).toBe(true);
    expect(ports.has("48789")).toBe(false);

    expect(getAllowedRemoteOrigins()).toEqual(
      new Set(["https://canonical.example.com"]),
    );
    expect(isAllowedOrigin("https://branded.example.com")).toBe(false);
  });

  it("a blank canonical value falls through to the branded alias (empty-is-unset)", () => {
    process.env.ELIZA_GATEWAY_PORT = "   ";
    process.env[`${BRAND}_GATEWAY_PORT`] = "49000";
    // Same empty-is-unset contract for the migrated single-process port read.
    process.env.ELIZA_PORT = "   ";
    process.env[`${BRAND}_PORT`] = "49100";
    invalidateCorsAllowedPorts();

    const ports = buildCorsAllowedPorts();
    expect(ports.has("49000")).toBe(true);
    expect(ports.has("49100")).toBe(true);
    // The blank canonical value must not shadow the present branded alias, and
    // the read must still not materialize the mirror.
    expect(isAllowedOrigin("http://localhost:49000")).toBe(true);
    expect(isAllowedOrigin("http://localhost:49100")).toBe(true);
    expect(process.env.ELIZA_PORT).toBe("   ");
  });
});
