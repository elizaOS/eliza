import { expect, test } from "bun:test";
import { requireProtectedStaging } from "./staging-acceptance.mjs";

const fixtureKey = `eliza_${"a".repeat(64)}`;
const protectedRun = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "elizaOS/eliza",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/staging",
  ELIZA_NATIVE_STAGING_ACCEPTANCE: "1",
  ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app",
  ELIZAOS_CLOUD_API_KEY: fixtureKey,
};

test("protected staging admission retains the exact scoped key", () => {
  expect(requireProtectedStaging(protectedRun)).toBe(fixtureKey);
});

for (const [field, value] of [
  ["GITHUB_ACTIONS", "false"],
  ["GITHUB_REPOSITORY", "fork/eliza"],
  ["GITHUB_EVENT_NAME", "pull_request"],
  ["GITHUB_REF", "refs/heads/main"],
  ["ELIZA_NATIVE_STAGING_ACCEPTANCE", "0"],
  ["ELIZAOS_CLOUD_BASE_URL", "https://api.eliza.app"],
  ["ELIZAOS_CLOUD_API_KEY", ""],
  ["ELIZAOS_CLOUD_API_KEY", "external-provider-session"],
] as const) {
  test(`admission rejects ${field}=${value} without credential-bearing errors`, () => {
    let caught: unknown;
    try {
      requireProtectedStaging({ ...protectedRun, [field]: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Native staging acceptance failed");
    expect(String(caught)).not.toContain(fixtureKey);
  });
}
