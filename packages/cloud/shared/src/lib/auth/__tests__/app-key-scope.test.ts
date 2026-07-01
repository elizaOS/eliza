import { describe, expect, test } from "bun:test";
import { appKeyScopeViolation } from "../app-key-scope";

const APP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("appKeyScopeViolation (#10852) — per-app API key scoping", () => {
  test("allows user/session auth (org-scoped, unchanged)", async () => {
    const lookup = async () => {
      throw new Error("lookup must not run for user auth");
    };
    expect(await appKeyScopeViolation("session", "irrelevant", APP_B, lookup)).toBeNull();
    expect(await appKeyScopeViolation(undefined, undefined, APP_B, lookup)).toBeNull();
  });

  test("allows an ORG api key (owns no app → org-scoped)", async () => {
    const lookup = async () => undefined; // no app owns this key
    expect(await appKeyScopeViolation("api_key", "org-key-1", APP_B, lookup)).toBeNull();
  });

  test("allows an app's key on its OWN app route", async () => {
    const lookup = async () => ({ id: APP_B }); // this key belongs to app B
    expect(await appKeyScopeViolation("api_key", "b-key", APP_B, lookup)).toBeNull();
  });

  test("BLOCKS app A's key acting on sibling app B (the vulnerability)", async () => {
    const lookup = async () => ({ id: APP_A }); // key belongs to app A...
    const violation = await appKeyScopeViolation("api_key", "a-key", APP_B, lookup); // ...used on app B
    expect(violation).toBe("This API key is scoped to a different app");
  });

  test("guards even when apiKeyId is present but authMethod is not api_key", async () => {
    const lookup = async () => ({ id: APP_A });
    // Defensive: only enforce for the api_key path; a mislabeled context must not
    // 403 a legitimate org user.
    expect(await appKeyScopeViolation("session", "a-key", APP_B, lookup)).toBeNull();
  });
});
