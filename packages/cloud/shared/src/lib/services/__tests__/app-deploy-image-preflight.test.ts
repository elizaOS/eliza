// Exercises the apps-deploy immutable-image preflight scanner (#13097). The
// scanner is pure: it takes a list of (source, ref) entries and the
// digest-requirement flag, returns structured findings listing every mutable
// ref with its source and pinning type. Used at startup/preflight before
// arming the digest gate so a misconfiguration surfaces actionably instead of
// causing a confusing deploy-time rejection.
import { describe, expect, test } from "bun:test";
import {
  type ImagePreflightEntry,
  scanImageRefsForMutableTags,
} from "../app-deploy-image-preflight";

const DIGEST_REF = "ghcr.io/elizaos/app@sha256:" + "a".repeat(64);
const TAG_REF = "ghcr.io/elizaos/app:v1";
const LATEST_REF = "ghcr.io/elizaos/app";

describe("scanImageRefsForMutableTags", () => {
  test("returns allPinned=true when every ref is digest-pinned", () => {
    const entries: ImagePreflightEntry[] = [
      { source: "APP_DEFAULT_TEMPLATE_IMAGE", ref: DIGEST_REF },
      { source: "APP_PREBUILT_IMAGES[test]", ref: DIGEST_REF },
    ];
    const result = scanImageRefsForMutableTags(entries, true);
    expect(result.allPinned).toBe(true);
    expect(result.mutableRefs).toHaveLength(0);
  });

  test("flags a mutable tag ref with its source", () => {
    const entries: ImagePreflightEntry[] = [{ source: "APP_DEFAULT_TEMPLATE_IMAGE", ref: TAG_REF }];
    const result = scanImageRefsForMutableTags(entries, true);
    expect(result.allPinned).toBe(false);
    expect(result.mutableRefs).toHaveLength(1);
    expect(result.mutableRefs[0].source).toBe("APP_DEFAULT_TEMPLATE_IMAGE");
    expect(result.mutableRefs[0].ref).toBe(TAG_REF);
    expect(result.mutableRefs[0].pinning).toBe("tag");
    expect(result.mutableRefs[0].warning).toContain("pin to repo@sha256");
  });

  test("flags an implicit-latest ref (no tag, no digest)", () => {
    const entries: ImagePreflightEntry[] = [{ source: "APP_DEFAULT_IMAGE", ref: LATEST_REF }];
    const result = scanImageRefsForMutableTags(entries, true);
    expect(result.mutableRefs).toHaveLength(1);
    expect(result.mutableRefs[0].pinning).toBe("implicit-latest");
    expect(result.mutableRefs[0].warning).toContain("implicitly latest");
  });

  test("advisory warning when digest gate is off (requireDigest=false)", () => {
    const entries: ImagePreflightEntry[] = [{ source: "test", ref: TAG_REF }];
    const result = scanImageRefsForMutableTags(entries, false);
    expect(result.mutableRefs).toHaveLength(1);
    expect(result.mutableRefs[0].warning).toContain("advisory");
  });

  test("mixes pinned and mutable refs correctly", () => {
    const entries: ImagePreflightEntry[] = [
      { source: "pinned-one", ref: DIGEST_REF },
      { source: "mutable-one", ref: TAG_REF },
      { source: "pinned-two", ref: DIGEST_REF },
      { source: "mutable-two", ref: LATEST_REF },
    ];
    const result = scanImageRefsForMutableTags(entries, true);
    expect(result.allPinned).toBe(false);
    expect(result.mutableRefs).toHaveLength(2);
    expect(result.mutableRefs[0].source).toBe("mutable-one");
    expect(result.mutableRefs[1].source).toBe("mutable-two");
  });
});
