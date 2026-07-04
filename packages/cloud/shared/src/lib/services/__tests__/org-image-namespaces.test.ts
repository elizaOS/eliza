// Exercises org image namespaces behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { isCodingContainerImageAllowed } from "../coding-containers";
import { getOrgImageNamespaces, normalizeOrgImageNamespaces } from "../org-image-namespaces";

// The per-org extension is a SECOND chance after the platform-wide env
// allowlist denies — so its normalization is itself a security gate: any entry
// it accepts becomes runnable-image surface for that org. Everything not a
// single-namespace registry glob must be dropped (fail-closed), never widened.
describe("normalizeOrgImageNamespaces (shape gate)", () => {
  test("accepts single-namespace registry globs", () => {
    expect(normalizeOrgImageNamespaces(["ghcr.io/nubscarson/*", "docker.io/some-org/*"])).toEqual([
      "ghcr.io/nubscarson/*",
      "docker.io/some-org/*",
    ]);
  });

  test("lowercases + trims entries (GitHub logins can be mixed-case)", () => {
    expect(normalizeOrgImageNamespaces(["  ghcr.io/NubsCarson/*  "])).toEqual([
      "ghcr.io/nubscarson/*",
    ]);
  });

  test("drops gate-opening entries: bare *, whole-registry, exact refs, deep paths", () => {
    expect(
      normalizeOrgImageNamespaces([
        "*", // would disable the gate entirely
        "ghcr.io/*", // whole registry
        "ghcr.io/nubscarson/app:v1", // exact ref, not a namespace glob
        "ghcr.io/nubscarson/deep/nested/*", // multi-segment path
        "nubscarson/*", // no registry host (dotless)
        "ghcr.io//*", // empty namespace
      ]),
    ).toEqual([]);
  });

  test("drops non-string members and non-array values", () => {
    expect(normalizeOrgImageNamespaces([42, null, { evil: true }])).toEqual([]);
    expect(normalizeOrgImageNamespaces("ghcr.io/nubscarson/*")).toEqual([]);
    expect(normalizeOrgImageNamespaces(undefined)).toEqual([]);
    expect(normalizeOrgImageNamespaces(null)).toEqual([]);
  });

  test("dedupes and caps a pathological list", () => {
    const raw = Array.from({ length: 100 }, (_, i) => `ghcr.io/user-${i % 50}/*`);
    const out = normalizeOrgImageNamespaces(raw);
    expect(out.length).toBe(32);
    expect(new Set(out).size).toBe(out.length);
  });

  test("accepted entries drive the REAL gate: org namespace passes, others still deny", () => {
    const orgList = normalizeOrgImageNamespaces(["ghcr.io/nubscarson/*"]);
    expect(isCodingContainerImageAllowed("ghcr.io/nubscarson/my-app:v1", orgList)).toBe(true);
    expect(isCodingContainerImageAllowed("ghcr.io/evil/pwn:latest", orgList)).toBe(false);
    // the dropped wildcard could never re-open the gate
    expect(
      isCodingContainerImageAllowed("docker.io/evil/pwn", normalizeOrgImageNamespaces(["*"])),
    ).toBe(false);
  });
});

describe("getOrgImageNamespaces (fail-closed wrapper)", () => {
  test("normalizes the settings value read for the org", async () => {
    const out = await getOrgImageNamespaces("org-1", async (orgId) => {
      expect(orgId).toBe("org-1");
      return ["ghcr.io/NubsCarson/*", "ghcr.io/*"];
    });
    expect(out).toEqual(["ghcr.io/nubscarson/*"]);
  });

  test("returns [] for a missing/unset settings key", async () => {
    expect(await getOrgImageNamespaces("org-1", async () => undefined)).toEqual([]);
  });

  test("returns [] when the read throws (deny, never propagate)", async () => {
    expect(
      await getOrgImageNamespaces("org-1", async () => {
        throw new Error("db down");
      }),
    ).toEqual([]);
  });

  test("returns [] for an empty org id without reading", async () => {
    let called = false;
    const out = await getOrgImageNamespaces("", async () => {
      called = true;
      return ["ghcr.io/nubscarson/*"];
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
