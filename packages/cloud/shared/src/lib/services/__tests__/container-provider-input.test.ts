// Exercises container provider input behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  APP_CONTAINER_DEFAULTS,
  buildContainerProvisionInput,
  type ContainerProvisionParams,
} from "../container-provider-input";

const base: ContainerProvisionParams = {
  name: "nubilio-web",
  projectName: "nubilio",
  organizationId: "org-1",
  userId: "user-1",
  image: "ghcr.io/nubs/nubilio:latest",
};

describe("buildContainerProvisionInput", () => {
  test("applies defaults for unset fields", () => {
    const input = buildContainerProvisionInput(base);
    expect(input.port).toBe(APP_CONTAINER_DEFAULTS.port);
    expect(input.desiredCount).toBe(APP_CONTAINER_DEFAULTS.desiredCount);
    expect(input.cpu).toBe(APP_CONTAINER_DEFAULTS.cpu);
    expect(input.memoryMb).toBe(APP_CONTAINER_DEFAULTS.memoryMb);
    expect(input.healthCheckPath).toBe(APP_CONTAINER_DEFAULTS.healthCheckPath);
    expect(input.apiKeyId).toBeNull();
  });

  test("overrides win over defaults and carry the core fields through", () => {
    const input = buildContainerProvisionInput({
      ...base,
      port: 8080,
      cpu: 2,
      memoryMb: 1024,
      healthCheckPath: "/healthz",
      description: "nubilio app",
    });
    expect(input.port).toBe(8080);
    expect(input.cpu).toBe(2);
    expect(input.memoryMb).toBe(1024);
    expect(input.healthCheckPath).toBe("/healthz");
    expect(input.image).toBe(base.image);
    expect(input.name).toBe(base.name);
    expect(input.organizationId).toBe(base.organizationId);
    expect(input.description).toBe("nubilio app");
  });

  // The load-bearing invariant: the apps builder NEVER injects DATABASE_URL
  // (the inverse of the agent path's shared-DB force-overwrite).
  test("never auto-injects DATABASE_URL", () => {
    const input = buildContainerProvisionInput({
      ...base,
      environmentVars: { NODE_ENV: "production", PORT: "3000" },
    });
    expect(input.environmentVars?.DATABASE_URL).toBeUndefined();
    expect(input.environmentVars).toEqual({ NODE_ENV: "production", PORT: "3000" });
  });

  test("with no env at all, no DATABASE_URL appears", () => {
    const input = buildContainerProvisionInput(base);
    expect(input.environmentVars?.DATABASE_URL).toBeUndefined();
  });

  test("forwards a caller-supplied (per-tenant) DATABASE_URL verbatim", () => {
    // The isolated per-tenant DSN is the caller's responsibility (a later unit);
    // the builder passes it through untouched, never sourcing it from the env.
    const dsn = "postgresql://app_x:pw@cluster1/db_app_x?sslmode=require";
    const input = buildContainerProvisionInput({
      ...base,
      environmentVars: { DATABASE_URL: dsn },
    });
    expect(input.environmentVars?.DATABASE_URL).toBe(dsn);
  });

  test("does not let callers mutate the output env by reference", () => {
    const env = { FOO: "bar" };
    const input = buildContainerProvisionInput({ ...base, environmentVars: env });
    env.FOO = "mutated";
    expect(input.environmentVars?.FOO).toBe("bar");
  });

  test("throws on missing required fields", () => {
    expect(() => buildContainerProvisionInput({ ...base, name: "" })).toThrow();
    expect(() => buildContainerProvisionInput({ ...base, image: "" })).toThrow();
    expect(() => buildContainerProvisionInput({ ...base, organizationId: "" })).toThrow();
  });
});
