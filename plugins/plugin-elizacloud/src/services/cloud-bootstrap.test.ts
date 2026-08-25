import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { CloudBootstrapServiceImpl } from "./cloud-bootstrap";

const ISSUER = "ELIZA_CLOUD_ISSUER";
const CONTAINER = "ELIZA_CLOUD_CONTAINER_ID";

function runtimeWithSettings(settings: Record<string, unknown> = {}) {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  };
}

function clearEnv() {
  delete process.env[ISSUER];
  delete process.env[CONTAINER];
}

beforeEach(clearEnv);
afterEach(clearEnv);

function newService(settings: Record<string, unknown> = {}) {
  return new CloudBootstrapServiceImpl(runtimeWithSettings(settings) as never);
}

describe("CloudBootstrapServiceImpl — no-fail-open trust anchor", () => {
  it("throws when the issuer is not configured anywhere", () => {
    expect(() => newService().getExpectedIssuer()).toThrow(
      /ELIZA_CLOUD_ISSUER is not configured/,
    );
  });

  it("rejects a slash-only and whitespace-only issuer instead of failing open", () => {
    for (const degenerate of ["/", "//", "///", "  ", "\t", "\n"]) {
      expect(() => newService({ [ISSUER]: degenerate }).getExpectedIssuer()).toThrow(
        /ELIZA_CLOUD_ISSUER is not configured/,
      );
    }
  });

  it("does not throw when a non-empty issuer is configured", () => {
    expect(
      newService({ [ISSUER]: "https://cloud.elizaos.com" }).getExpectedIssuer(),
    ).toBe("https://cloud.elizaos.com");
  });
});

describe("CloudBootstrapServiceImpl — issuer resolution", () => {
  it("prefers the runtime setting over the environment", () => {
    process.env[ISSUER] = "https://env.example.com";
    const service = newService({ [ISSUER]: "https://runtime.example.com" });
    expect(service.getExpectedIssuer()).toBe("https://runtime.example.com");
  });

  it("falls back to the environment when the runtime setting is missing", () => {
    process.env[ISSUER] = "https://env.example.com";
    expect(newService().getExpectedIssuer()).toBe("https://env.example.com");
  });

  it("ignores an empty-string runtime setting and uses the environment", () => {
    process.env[ISSUER] = "https://env.example.com";
    expect(newService({ [ISSUER]: "" }).getExpectedIssuer()).toBe(
      "https://env.example.com",
    );
  });

  it("trims trailing slashes from the issuer", () => {
    expect(newService({ [ISSUER]: "https://cloud.elizaos.com/" }).getExpectedIssuer()).toBe(
      "https://cloud.elizaos.com",
    );
    expect(
      newService({ [ISSUER]: "https://cloud.elizaos.com///" }).getExpectedIssuer(),
    ).toBe("https://cloud.elizaos.com");
  });

  it("trims surrounding whitespace from the issuer", () => {
    expect(
      newService({ [ISSUER]: "  https://cloud.elizaos.com/  " }).getExpectedIssuer(),
    ).toBe("https://cloud.elizaos.com");
  });
});

describe("CloudBootstrapServiceImpl — endpoint derivation", () => {
  it("builds the JWKS URL from the issuer without a double slash", () => {
    const service = newService({ [ISSUER]: "https://cloud.elizaos.com/" });
    expect(service.getJwksUrl()).toBe(
      "https://cloud.elizaos.com/.well-known/jwks.json",
    );
  });

  it("builds the revocation list URL from the issuer", () => {
    const service = newService({ [ISSUER]: "https://cloud.elizaos.com" });
    expect(service.getRevocationListUrl()).toBe(
      "https://cloud.elizaos.com/.well-known/revocations.json",
    );
  });

  it("propagates the no-fail-open error through endpoint derivation", () => {
    expect(() => newService().getJwksUrl()).toThrow(
      /ELIZA_CLOUD_ISSUER is not configured/,
    );
    expect(() => newService().getRevocationListUrl()).toThrow(
      /ELIZA_CLOUD_ISSUER is not configured/,
    );
  });
});

describe("CloudBootstrapServiceImpl — container id", () => {
  it("returns null when the container id is unset", () => {
    expect(newService().getExpectedContainerId()).toBeNull();
  });

  it("returns the configured container id", () => {
    expect(newService({ [CONTAINER]: "container-7" }).getExpectedContainerId()).toBe(
      "container-7",
    );
  });

  it("falls back to the environment for the container id", () => {
    process.env[CONTAINER] = "env-container";
    expect(newService().getExpectedContainerId()).toBe("env-container");
  });
});
