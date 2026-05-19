/**
 * Pure-helper tests for the app-deployments service + deploy route schema.
 *
 * Mirrors the contract these two routes wire together:
 *   POST /api/v1/apps/:id/deploy
 *   GET  /api/v1/apps/:id/deploy/status
 *
 * Route-level happy-path / auth / not-found scenarios are exercised by the
 * existing e2e suite under packages/cloud-api/test/e2e (which has live
 * Postgres + Redis). The helpers below are pure and run without any I/O.
 */

import { describe, expect, test } from "bun:test";

import {
  deploymentIdFor,
  publicStatusFor,
} from "@elizaos/cloud-shared/lib/services/app-deployments-helpers.ts";
import { DeployBodySchema } from "../v1/apps/[id]/deploy/schema";

describe("DeployBodySchema", () => {
  test("accepts an empty body — all fields are optional", () => {
    const parsed = DeployBodySchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  test("accepts the full body shape", () => {
    const parsed = DeployBodySchema.safeParse({
      repoUrl: "https://github.com/2-A-M/example",
      ref: "main",
      dockerfile: "./Dockerfile",
      env: { FOO: "bar", BAZ: "qux" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.repoUrl).toBe("https://github.com/2-A-M/example");
      expect(parsed.data.ref).toBe("main");
      expect(parsed.data.dockerfile).toBe("./Dockerfile");
      expect(parsed.data.env).toEqual({ FOO: "bar", BAZ: "qux" });
    }
  });

  test("rejects a non-URL repoUrl", () => {
    const parsed = DeployBodySchema.safeParse({ repoUrl: "not-a-url" });
    expect(parsed.success).toBe(false);
  });

  test("rejects an empty ref string", () => {
    const parsed = DeployBodySchema.safeParse({ ref: "" });
    expect(parsed.success).toBe(false);
  });

  test("rejects an env entry with a non-string value", () => {
    const parsed = DeployBodySchema.safeParse({
      env: { FOO: 42 as unknown as string },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("publicStatusFor", () => {
  test("maps every persisted enum value to a public status", () => {
    expect(publicStatusFor("draft")).toBe("DRAFT");
    expect(publicStatusFor("building")).toBe("BUILDING");
    expect(publicStatusFor("deploying")).toBe("BUILDING");
    expect(publicStatusFor("deployed")).toBe("READY");
    expect(publicStatusFor("failed")).toBe("ERROR");
  });
});

describe("deploymentIdFor", () => {
  test("composes `${appId}:${lastDeployedAt.toISOString()}`", () => {
    const id = deploymentIdFor({
      id: "abc-123",
      last_deployed_at: new Date("2026-05-19T12:00:00.000Z"),
    });
    expect(id).toBe("abc-123:2026-05-19T12:00:00.000Z");
  });

  test("uses the literal '0' when last_deployed_at is null", () => {
    const id = deploymentIdFor({
      id: "abc-123",
      last_deployed_at: null,
    });
    expect(id).toBe("abc-123:0");
  });
});
