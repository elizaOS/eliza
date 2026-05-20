import { describe, expect, it } from "bun:test";
import { evaluateEnv } from "../../../scripts/validate-env";

const baseEnv = {
  DATABASE_URL: "postgresql://localhost:5432/feed",
  NEXT_PUBLIC_PRIVY_APP_ID: "privy-app-id",
  PRIVY_APP_SECRET: "privy-app-secret",
  CRON_SECRET: "cron-secret",
  GROQ_API_KEY: "groq-key",
};

describe("scripts/validate-env", () => {
  it("passes with baseline required variables", () => {
    const result = evaluateEnv({
      env: { ...baseEnv },
      profile: "local",
    });

    expect(result.valid).toBe(true);
    expect(result.missing.length).toBe(0);
  });

  it("accepts Privy app id alias and alternate LLM provider key", () => {
    const result = evaluateEnv({
      env: {
        DATABASE_URL: baseEnv.DATABASE_URL,
        PRIVY_APP_ID: "legacy-privy-app-id",
        PRIVY_APP_SECRET: baseEnv.PRIVY_APP_SECRET,
        CRON_SECRET: baseEnv.CRON_SECRET,
        OPENAI_API_KEY: "openai-key",
      },
      profile: "local",
    });

    expect(result.valid).toBe(true);
    expect(result.missing.length).toBe(0);
  });

  it("requires sender address when SENDGRID_API_KEY is set", () => {
    const result = evaluateEnv({
      env: {
        ...baseEnv,
        SENDGRID_API_KEY: "sg-key",
      },
      profile: "local",
    });

    expect(result.valid).toBe(false);
    expect(
      result.missing.some((item) => item.id === "sendgrid-from-address"),
    ).toBe(true);
  });

  it("requires Agent0 settings when AGENT0_ENABLED=true", () => {
    const result = evaluateEnv({
      env: {
        ...baseEnv,
        AGENT0_ENABLED: "true",
      },
      profile: "local",
    });

    expect(result.valid).toBe(false);
    expect(result.missing.some((item) => item.id === "agent0-core")).toBe(true);
    expect(
      result.missing.some((item) => item.id === "agent0-ipfs-provider"),
    ).toBe(true);
  });

  it("requires NEXT_PUBLIC_APP_URL in staging and production", () => {
    const stagingResult = evaluateEnv({
      env: { ...baseEnv },
      profile: "staging",
    });

    expect(stagingResult.valid).toBe(false);
    expect(
      stagingResult.missing.some((item) => item.id === "public-app-url"),
    ).toBe(true);
  });

  it("reports deprecated and undocumented keys from env files", () => {
    const result = evaluateEnv({
      env: {
        ...baseEnv,
        WAITLIST_MODE: "false",
        CUSTOM_ONLY_IN_LOCAL_ENV: "1",
      },
      profile: "local",
      documentedKeys: new Set(Object.keys(baseEnv)),
      declaredFileKeys: new Set(["WAITLIST_MODE", "CUSTOM_ONLY_IN_LOCAL_ENV"]),
    });

    expect(result.valid).toBe(true);
    expect(result.deprecated.some((item) => item.key === "WAITLIST_MODE")).toBe(
      true,
    );
    expect(result.undocumentedKeys).toEqual(["CUSTOM_ONLY_IN_LOCAL_ENV"]);
  });
});
