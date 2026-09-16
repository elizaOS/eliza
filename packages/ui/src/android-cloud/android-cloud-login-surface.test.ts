/** Verifies the in-app Android Cloud login surface geometry and HTTPS policy. */

import { describe, expect, it } from "vitest";
import { getAndroidCloudLoginSurfaceBounds } from "./android-cloud-login-surface";

describe("Android Cloud login surface", () => {
  it("leaves a host-rendered header hole for the cancel affordance", () => {
    const bounds = getAndroidCloudLoginSurfaceBounds({
      width: 400,
      height: 800,
    });

    expect(bounds).toMatchObject({
      x: 12,
      y: 72,
      width: 376,
      height: 716,
    });
    expect(bounds.outerClip.cornerRadii).toEqual({
      topLeft: 16,
      topRight: 16,
      bottomRight: 16,
      bottomLeft: 16,
    });
  });

  it("fails closed for a viewport smaller than the header", () => {
    const bounds = getAndroidCloudLoginSurfaceBounds({
      width: 8,
      height: 40,
    });

    expect(bounds.width).toBe(0);
    expect(bounds.height).toBe(0);
  });
});
