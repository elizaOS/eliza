import { expect, test } from "bun:test";
import { runtimeSettings } from "./configuration";

const source = {
  SERVER_NAME: "retained-server-identity",
  TIER: "shared",
  CAPACITY: "50",
  AGENT_SERVER_SHARED_SECRET: "fixture-only-shared-secret",
  DATABASE_URL: "postgresql://fixture:fixture@database.example.test/agents",
  REDIS_URL: "rediss://fixture:fixture@state.example.test/0",
  AGENT_SERVER_URL:
    "https://eliza-agent-server-staging.square-rain-7251.workers.dev",
};

test("preserves identity, shared state, credentials, and runtime flags", () => {
  const settings = runtimeSettings(
    JSON.stringify({
      ...source,
      RAILWAY_PRIVATE_DOMAIN: "old.railway.internal",
      PORT: "8080",
      REQUIRE_EFFECT_RECEIPTS: "true",
    }),
    "staging",
  );
  expect(settings).toEqual({
    ...source,
    PORT: "3000",
    REQUIRE_EFFECT_RECEIPTS: "true",
  });
});

test("rejects cross-environment advertisement and private storage before startup", () => {
  expect(() => runtimeSettings(JSON.stringify(source), "production")).toThrow(
    "advertised URL",
  );
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "REDIS_URL"]) {
    const protocol = key === "REDIS_URL" ? "redis" : "postgresql";
    expect(() =>
      runtimeSettings(
        JSON.stringify({
          ...source,
          [key]: `${protocol}://fixture:fixture@old.railway.internal/state`,
        }),
        "staging",
      ),
    ).toThrow("storage must be reachable");
  }
});

test("never starts with missing ownership or authentication settings", () => {
  for (const key of [
    "SERVER_NAME",
    "TIER",
    "AGENT_SERVER_SHARED_SECRET",
    "DATABASE_URL",
    "REDIS_URL",
  ]) {
    expect(() =>
      runtimeSettings(JSON.stringify({ ...source, [key]: " " }), "staging"),
    ).toThrow(`Missing agent-server setting: ${key}`);
  }
  for (const capacity of ["0", "201", "Infinity", "1.5", "050", "-1"]) {
    expect(() =>
      runtimeSettings(
        JSON.stringify({ ...source, CAPACITY: capacity }),
        "staging",
      ),
    ).toThrow("capacity");
  }
});

test("configuration errors do not include secret-bearing JSON or endpoint values", () => {
  expect(() =>
    runtimeSettings('{"SECRET":"private-fixture" trailing', "staging"),
  ).toThrow("Invalid agent-server runtime configuration JSON");
  try {
    runtimeSettings(
      JSON.stringify({ ...source, DATABASE_URL: "private-fixture" }),
      "staging",
    );
    throw new Error("Expected configuration rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("private-fixture");
  }
});
