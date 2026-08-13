/**
 * Verifies local Docker endpoint selection without starting containers.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  resolveLocalDockerEndpointHost,
  rewriteLocalDockerLoopback,
} from "./local-docker-sandbox-provider";

const originalSuffix = process.env.ELIZA_LOCAL_DOCKER_HOST_SUFFIX;

afterEach(() => {
  if (originalSuffix === undefined) {
    delete process.env.ELIZA_LOCAL_DOCKER_HOST_SUFFIX;
  } else {
    process.env.ELIZA_LOCAL_DOCKER_HOST_SUFFIX = originalSuffix;
  }
});

describe("resolveLocalDockerEndpointHost", () => {
  test("keeps loopback-published endpoints as the default", () => {
    delete process.env.ELIZA_LOCAL_DOCKER_HOST_SUFFIX;

    expect(resolveLocalDockerEndpointHost("agent-123")).toBeNull();
  });

  test("uses OrbStack's container DNS suffix when explicitly configured", () => {
    process.env.ELIZA_LOCAL_DOCKER_HOST_SUFFIX = "Orb.Local";

    expect(resolveLocalDockerEndpointHost("agent-123")).toBe("agent-123.orb.local");
  });

  test("rejects a suffix that could alter the recorded URL", () => {
    process.env.ELIZA_LOCAL_DOCKER_HOST_SUFFIX = "orb.local/path";

    expect(() => resolveLocalDockerEndpointHost("agent-123")).toThrow(
      "Invalid local Docker host suffix",
    );
  });
});

test("rewrites loopback provider endpoints for container access", () => {
  expect(rewriteLocalDockerLoopback("http://127.0.0.1:18080/v1")).toBe(
    "http://host.docker.internal:18080/v1",
  );
  expect(rewriteLocalDockerLoopback("http://localhost:18080/v1")).toBe(
    "http://host.docker.internal:18080/v1",
  );
});
