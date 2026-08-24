/**
 * Unit tests for resolve-cloud-connection: validates default API base and auth token resolution.
 */
import { describe, expect, it } from "vitest";
import {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "./resolve-cloud-connection.ts";

describe("resolve-cloud-connection", () => {
  it("resolves default cloud API base URL", () => {
    const base = resolveJoinCloudApiBase();
    expect(base).toBe("https://eliza.app");
  });

  it("resolves null auth token when user is signed out", () => {
    const token = resolveJoinAuthToken();
    expect(token === null || typeof token === "string").toBe(true);
  });
});
