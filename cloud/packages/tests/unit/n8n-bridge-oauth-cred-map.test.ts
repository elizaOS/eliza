/**
 * N8N Bridge — Credential Type Mapping Unit Tests
 *
 * Tests for lib/eliza/plugin-n8n-bridge/oauth-cred-map.ts
 * Verifies n8n credential type → cloud platform mapping.
 */

import { describe, expect, test } from "bun:test";
import {
  getCredPrefixesForPlatform,
  mapCredTypeToCloudPlatform,
} from "@/lib/eliza/plugin-n8n-bridge/oauth-cred-map";

describe("mapCredTypeToCloudPlatform", () => {
  // Google family
  test("maps gmail credentials to google", () => {
    expect(mapCredTypeToCloudPlatform("gmailOAuth2")).toBe("google");
    expect(mapCredTypeToCloudPlatform("gmailOAuth2Api")).toBe("google");
  });

  test("maps google credentials to google", () => {
    expect(mapCredTypeToCloudPlatform("googleSheetsOAuth2Api")).toBe("google");
    expect(mapCredTypeToCloudPlatform("googleDriveOAuth2Api")).toBe("google");
    expect(mapCredTypeToCloudPlatform("googleCalendarOAuth2Api")).toBe("google");
    expect(mapCredTypeToCloudPlatform("googleDocsOAuth2Api")).toBe("google");
    expect(mapCredTypeToCloudPlatform("googleApi")).toBe("google");
  });

  test("maps gSuite credentials to google", () => {
    expect(mapCredTypeToCloudPlatform("gSuiteAdminOAuth2Api")).toBe("google");
  });

  test("maps youTube credentials to google", () => {
    expect(mapCredTypeToCloudPlatform("youTubeOAuth2Api")).toBe("google");
  });

  // Other platforms
  test("maps slack credentials to slack", () => {
    expect(mapCredTypeToCloudPlatform("slackApi")).toBe("slack");
    expect(mapCredTypeToCloudPlatform("slackOAuth2Api")).toBe("slack");
  });

  test("maps github credentials to github", () => {
    expect(mapCredTypeToCloudPlatform("githubApi")).toBe("github");
    expect(mapCredTypeToCloudPlatform("githubOAuth2Api")).toBe("github");
  });

  test("maps linear credentials to linear", () => {
    expect(mapCredTypeToCloudPlatform("linearApi")).toBe("linear");
    expect(mapCredTypeToCloudPlatform("linearOAuth2Api")).toBe("linear");
  });

  test("maps notion credentials to notion", () => {
    expect(mapCredTypeToCloudPlatform("notionApi")).toBe("notion");
    expect(mapCredTypeToCloudPlatform("notionOAuth2Api")).toBe("notion");
  });

  test("maps twitter credentials to twitter", () => {
    expect(mapCredTypeToCloudPlatform("twitterOAuth2Api")).toBe("twitter");
  });

  // Unsupported
  test("returns null for unsupported credential types", () => {
    expect(mapCredTypeToCloudPlatform("hubspotOAuth2Api")).toBeNull();
    expect(mapCredTypeToCloudPlatform("stripeApi")).toBeNull();
    expect(mapCredTypeToCloudPlatform("shopifyApi")).toBeNull();
    expect(mapCredTypeToCloudPlatform("")).toBeNull();
  });

  // Prefix priority (longest match first)
  test("does not false-positive on partial prefix overlaps", () => {
    expect(mapCredTypeToCloudPlatform("gSuiteAdminOAuth2Api")).toBe("google");
  });
});

describe("getCredPrefixesForPlatform", () => {
  test("returns prefixes for google", () => {
    const prefixes = getCredPrefixesForPlatform("google");
    expect(prefixes).toContain("gmail");
    expect(prefixes).toContain("google");
    expect(prefixes).toContain("gSuite");
    expect(prefixes).toContain("youTube");
    expect(prefixes).toHaveLength(4);
  });

  test("returns prefixes for slack", () => {
    expect(getCredPrefixesForPlatform("slack")).toEqual(["slack"]);
  });

  test("returns empty array for unknown platform", () => {
    expect(getCredPrefixesForPlatform("hubspot")).toEqual([]);
    expect(getCredPrefixesForPlatform("")).toEqual([]);
  });
});
