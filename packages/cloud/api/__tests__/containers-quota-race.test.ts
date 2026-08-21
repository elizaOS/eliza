/**
 * Drives the real container POST boundary with deterministic collaborators to
 * prove an at-cap replica preflight still reaches primary admission and an
 * atomic quota loser receives the canonical 402 response rather than a 500.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { QuotaExceededError } from "@/db/repositories/containers";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as codingContainersActual from "@/lib/services/coding-containers";
import * as containersActual from "@/lib/services/containers";
import * as clientActual from "@/lib/services/containers/hetzner-client/client";
import * as loggerActual from "@/lib/utils/logger";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
}));
const getActiveByProjectName = mock(async () => null);
const checkQuota = mock(async () => ({
  availability: "ready" as const,
  allowed: false,
  current: 2,
  max: 2,
  error: "Container quota exceeded (2/2)",
}));
const createContainer = mock(async () => {
  throw new QuotaExceededError(
    "Container quota exceeded. Current: 2, Max: 2",
    2,
    2,
  );
});

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/containers", () => ({
  ...containersActual,
  containersService: {
    ...containersActual.containersService,
    getActiveByProjectName,
    checkQuota,
  },
}));
mock.module("@/lib/services/containers/hetzner-client/client", () => ({
  ...clientActual,
  getHetznerContainersClient: () => ({ createContainer }),
}));
mock.module("@/lib/services/coding-containers", () => ({
  ...codingContainersActual,
  isCodingContainerImageAllowed: () => true,
  imageRequiresDigestPin: () => false,
}));
mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const { default: route } = await import("../v1/containers/route");
const app = new Hono().route("/api/v1/containers", route);

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/services/containers", () => containersActual);
  mock.module(
    "@/lib/services/containers/hetzner-client/client",
    () => clientActual,
  );
  mock.module("@/lib/services/coding-containers", () => codingContainersActual);
  mock.module("@/lib/utils/logger", () => loggerActual);
});

beforeEach(() => {
  getActiveByProjectName.mockClear();
  checkQuota.mockClear();
  createContainer.mockClear();
});

describe("POST /api/v1/containers quota race", () => {
  test("maps the primary quota loser to the preflight 402 contract", async () => {
    const response = await app.request("/api/v1/containers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "race contender",
        projectName: "project-two",
        image: "ghcr.io/elizaos/eliza:stable",
      }),
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({
      success: false,
      error: "Container quota exceeded (2/2)",
      quota: {
        availability: "ready",
        allowed: false,
        current: 2,
        max: 2,
        error: "Container quota exceeded (2/2)",
      },
    });
    expect(checkQuota).toHaveBeenCalledTimes(1);
    expect(createContainer).toHaveBeenCalledTimes(1);
  });
});
