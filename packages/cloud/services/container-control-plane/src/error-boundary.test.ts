/**
 * Unit coverage for the control-plane HTTP error envelope. Arbitrary provider
 * exceptions must remain internal even when they contain HTML or stack paths.
 */
import { describe, expect, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/errors";
import { HetznerClientError } from "@elizaos/cloud-shared/lib/services/containers/hetzner-client";
import {
  containerControlPlaneErrorBody,
  containerControlPlaneErrorResponse,
} from "./index";

describe("container control-plane error boundary", () => {
  test("returns a stable envelope for an unexpected exception", () => {
    const marker = "<script>secret /srv/control-plane.ts:42</script>";
    const error = new Error(marker);
    error.stack = `Error: ${marker}\n    at /srv/control-plane.ts:42:1`;

    expect(containerControlPlaneErrorBody(error)).toEqual({
      success: false,
      code: "container_control_plane_error",
      error: "Container control-plane request failed",
    });
  });

  test("derives status and message from the stable API error code", () => {
    const error = new ApiError(
      599,
      "access_denied",
      "password=secret /srv/private.ts:9",
    );

    expect(containerControlPlaneErrorResponse(error)).toEqual({
      status: 403,
      body: { success: false, code: "access_denied", error: "Access denied" },
    });
  });

  test("preserves provider classification without provider diagnostics", () => {
    const error = new HetznerClientError(
      "container_create_failed",
      "ssh private key leaked at /root/.ssh/id_ed25519",
    );

    expect(containerControlPlaneErrorResponse(error)).toEqual({
      status: 502,
      body: {
        success: false,
        code: "container_create_failed",
        error: "Container operation failed",
      },
    });
  });

  test("survives thrown proxies with hostile prototype and property traps", () => {
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error("prototype secret");
      },
      get() {
        throw new Error("getter secret");
      },
    });

    expect(containerControlPlaneErrorResponse(hostile)).toEqual({
      status: 500,
      body: {
        success: false,
        code: "container_control_plane_error",
        error: "Container control-plane request failed",
      },
    });
  });
});
