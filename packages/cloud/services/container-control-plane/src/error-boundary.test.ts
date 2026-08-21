/**
 * Unit coverage for the control-plane HTTP error envelope. Arbitrary provider
 * exceptions must remain internal even when they contain HTML or stack paths.
 */
import { describe, expect, test } from "bun:test";
import { containerControlPlaneErrorBody } from "./index";

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
});
