// Exercises paths.mount path behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "vitest";
import { DEFAULT_VOLUME_MOUNT_PATH } from "./constants";
import { validateContainerMountPath } from "./paths";

/**
 * `validateContainerMountPath` sanitizes the volume mount path for a deployed
 * container (#8801 — shipped untested). It is a container-escape / path-traversal
 * boundary: an attacker-influenced mount path must not become `/` (mount the
 * whole host root), a relative path, or a `..` traversal. A regression here is a
 * container-escape, so the accept/normalize/reject paths are pinned.
 */
describe("validateContainerMountPath", () => {
  it("defaults an empty value to the standard mount path", () => {
    expect(validateContainerMountPath(undefined)).toBe(DEFAULT_VOLUME_MOUNT_PATH);
    expect(validateContainerMountPath("")).toBe(DEFAULT_VOLUME_MOUNT_PATH);
  });

  it("accepts a normal absolute path", () => {
    expect(validateContainerMountPath("/data")).toBe("/data");
    expect(validateContainerMountPath("/var/lib/app")).toBe("/var/lib/app");
  });

  it("normalizes duplicate and trailing slashes", () => {
    expect(validateContainerMountPath("//data//sub//")).toBe("/data/sub");
    expect(validateContainerMountPath("/data/")).toBe("/data");
  });

  it("REJECTS mounting the host root", () => {
    expect(() => validateContainerMountPath("/")).toThrow();
    expect(() => validateContainerMountPath("//")).toThrow();
  });

  it("REJECTS a relative (non-absolute) path", () => {
    expect(() => validateContainerMountPath("data")).toThrow();
    expect(() => validateContainerMountPath("relative/path")).toThrow();
  });

  it("REJECTS path-traversal and null bytes", () => {
    expect(() => validateContainerMountPath("/data/../etc")).toThrow();
    expect(() => validateContainerMountPath("/data/..")).toThrow();
    expect(() => validateContainerMountPath("/data\0/evil")).toThrow();
  });
});
