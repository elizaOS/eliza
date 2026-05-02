/**
 * Unit tests for CloudBootstrapServiceImpl.
 *
 * Covers env-var reads, runtime-setting overrides, missing-env behaviour
 * (must throw — no fail-open per remote-auth-hardening-plan §3.2), and
 * URL construction including trailing-slash normalization.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudBootstrapServiceImpl } from "../../services/cloud-bootstrap";

interface RuntimeSettings {
  [key: string]: string | undefined;
}

function fakeRuntime(settings: RuntimeSettings = {}) {
  return {
    getSetting(key: string) {
      return settings[key];
    },
  } as unknown as ConstructorParameters<typeof CloudBootstrapServiceImpl>[0];
}

const ENV_KEYS = ["ELIZA_CLOUD_ISSUER", "ELIZA_CLOUD_CONTAINER_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("CloudBootstrapServiceImpl", () => {
  it("reads issuer from runtime setting first", () => {
    process.env.ELIZA_CLOUD_ISSUER = "https://env.example.com";
    const svc = new CloudBootstrapServiceImpl(
      fakeRuntime({ ELIZA_CLOUD_ISSUER: "https://setting.example.com" })
    );
    expect(svc.getExpectedIssuer()).toBe("https://setting.example.com");
  });

  it("falls back to process.env when runtime setting is unset", () => {
    process.env.ELIZA_CLOUD_ISSUER = "https://env.example.com";
    const svc = new CloudBootstrapServiceImpl(fakeRuntime());
    expect(svc.getExpectedIssuer()).toBe("https://env.example.com");
  });

  it("getExpectedIssuer throws when both runtime setting and env are unset", () => {
    const svc = new CloudBootstrapServiceImpl(fakeRuntime());
    expect(() => svc.getExpectedIssuer()).toThrow(/ELIZA_CLOUD_ISSUER is not configured/);
  });

  it("getExpectedIssuer throws when issuer is the empty string", () => {
    process.env.ELIZA_CLOUD_ISSUER = "";
    const svc = new CloudBootstrapServiceImpl(fakeRuntime({ ELIZA_CLOUD_ISSUER: "" }));
    expect(() => svc.getExpectedIssuer()).toThrow(/ELIZA_CLOUD_ISSUER is not configured/);
  });

  it("getJwksUrl builds the well-known JWKS path", () => {
    const svc = new CloudBootstrapServiceImpl(
      fakeRuntime({ ELIZA_CLOUD_ISSUER: "https://cloud.eliza.how" })
    );
    expect(svc.getJwksUrl()).toBe("https://cloud.eliza.how/.well-known/jwks.json");
  });

  it("getRevocationListUrl builds the well-known revocations path", () => {
    const svc = new CloudBootstrapServiceImpl(
      fakeRuntime({ ELIZA_CLOUD_ISSUER: "https://cloud.eliza.how" })
    );
    expect(svc.getRevocationListUrl()).toBe("https://cloud.eliza.how/.well-known/revocations.json");
  });

  it("URL builders strip trailing slashes from the issuer", () => {
    const svc = new CloudBootstrapServiceImpl(
      fakeRuntime({ ELIZA_CLOUD_ISSUER: "https://cloud.eliza.how///" })
    );
    expect(svc.getExpectedIssuer()).toBe("https://cloud.eliza.how");
    expect(svc.getJwksUrl()).toBe("https://cloud.eliza.how/.well-known/jwks.json");
    expect(svc.getRevocationListUrl()).toBe("https://cloud.eliza.how/.well-known/revocations.json");
  });

  it("URL builders propagate the missing-issuer error (no silent default)", () => {
    const svc = new CloudBootstrapServiceImpl(fakeRuntime());
    expect(() => svc.getJwksUrl()).toThrow(/ELIZA_CLOUD_ISSUER is not configured/);
    expect(() => svc.getRevocationListUrl()).toThrow(/ELIZA_CLOUD_ISSUER is not configured/);
  });

  it("getExpectedContainerId returns the configured value when set", () => {
    process.env.ELIZA_CLOUD_CONTAINER_ID = "container-from-env";
    const svc = new CloudBootstrapServiceImpl(fakeRuntime());
    expect(svc.getExpectedContainerId()).toBe("container-from-env");
  });

  it("getExpectedContainerId prefers runtime setting over env", () => {
    process.env.ELIZA_CLOUD_CONTAINER_ID = "container-from-env";
    const svc = new CloudBootstrapServiceImpl(
      fakeRuntime({ ELIZA_CLOUD_CONTAINER_ID: "container-from-setting" })
    );
    expect(svc.getExpectedContainerId()).toBe("container-from-setting");
  });

  it("getExpectedContainerId returns null when unset (does NOT throw)", () => {
    const svc = new CloudBootstrapServiceImpl(fakeRuntime());
    expect(svc.getExpectedContainerId()).toBeNull();
  });

  it("getExpectedContainerId returns null when env is the empty string", () => {
    process.env.ELIZA_CLOUD_CONTAINER_ID = "";
    const svc = new CloudBootstrapServiceImpl(fakeRuntime());
    expect(svc.getExpectedContainerId()).toBeNull();
  });

  it("registers under serviceType CLOUD_BOOTSTRAP for runtime.getService lookups", () => {
    expect(CloudBootstrapServiceImpl.serviceType).toBe("CLOUD_BOOTSTRAP");
  });

  it("start() returns a working service instance and logs trust anchor", async () => {
    process.env.ELIZA_CLOUD_ISSUER = "https://cloud.eliza.how";
    process.env.ELIZA_CLOUD_CONTAINER_ID = "milady-1";
    const runtime = fakeRuntime();
    const svc = (await CloudBootstrapServiceImpl.start(
      runtime as unknown as Parameters<typeof CloudBootstrapServiceImpl.start>[0]
    )) as CloudBootstrapServiceImpl;
    expect(svc.getExpectedIssuer()).toBe("https://cloud.eliza.how");
    expect(svc.getExpectedContainerId()).toBe("milady-1");
    await svc.stop();
  });
});
