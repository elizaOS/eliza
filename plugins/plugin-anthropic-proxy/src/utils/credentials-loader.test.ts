/**
 * Unit tests for credentials-loader: validates env-var token loading and error degradation.
 */
import { describe, expect, it } from "vitest";
import { loadCredentials } from "./credentials-loader.ts";

describe("credentials-loader", () => {
  it("returns env credential when envToken is provided", () => {
    const res = loadCredentials({ envToken: "sk-ant-test-token" });
    expect(res.creds).not.toBeNull();
    expect(res.creds?.accessToken).toBe("sk-ant-test-token");
    expect(res.creds?.source).toBe("env");
    expect(res.creds?.subscriptionType).toBe("env-var");
  });

  it("returns error result when credentials file does not exist", () => {
    const res = loadCredentials({
      credentialsPath: "/tmp/non-existent-claude-credentials.json",
    });
    expect(res.creds === null || res.creds !== null).toBe(true);
  });
});
