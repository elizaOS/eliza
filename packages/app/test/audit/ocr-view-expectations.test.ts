/**
 * Drift guards for the aesthetic audit's closed route-to-OCR-policy registry.
 * The test reads canonical navigation source and shared plugin cases so a new
 * capturable surface cannot enter without an explicit semantic contract.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNavigationTabPaths } from "../ui-smoke/aesthetic-audit-rules";
import {
  BUILTIN_TAB_PATHS,
  buildAuditViewCases,
} from "../ui-smoke/aesthetic-audit-view-cases";
import {
  normalize,
  positiveExpectationMatches,
} from "../ui-smoke/ocr-content-rules";
import {
  resolveViewOcrPolicy,
  VIEW_OCR_POLICIES,
} from "../ui-smoke/ocr-view-expectations";

const appDirCandidates = [
  process.cwd(),
  join(process.cwd(), "packages", "app"),
].filter((candidate) =>
  existsSync(join(candidate, "test", "ui-smoke", "plugin-view-cases.ts")),
);
if (appDirCandidates.length !== 1) {
  throw new Error(
    `Expected one app package root from ${process.cwd()}, found ${appDirCandidates.length}`,
  );
}
const [APP_DIR] = appDirCandidates;
const NAVIGATION_SOURCE = resolve(
  APP_DIR,
  "../ui/src/navigation/builtin-route-descriptors.ts",
);

describe("aesthetic audit semantic OCR policy coverage", () => {
  it("declares exactly one policy for every captured view slug", () => {
    const auditedSlugs = buildAuditViewCases()
      .map((view) => view.slug)
      .sort();
    expect(new Set(auditedSlugs).size).toBe(auditedSlugs.length);
    expect(Object.keys(VIEW_OCR_POLICIES).sort()).toEqual(auditedSlugs);
  });

  it("covers every distinct canonical built-in route without path drift", () => {
    const navigationPaths = parseNavigationTabPaths(
      readFileSync(NAVIGATION_SOURCE, "utf8"),
    );
    const declaredKeys = Object.keys(BUILTIN_TAB_PATHS);
    expect(declaredKeys.filter((key) => !(key in navigationPaths))).toEqual([]);
    expect(
      declaredKeys.filter(
        (key) => BUILTIN_TAB_PATHS[key] !== navigationPaths[key],
      ),
    ).toEqual([]);
    const pluginOwnedPaths = new Set([
      "/phone",
      "/messages",
      "/contacts",
    ]);
    const hostOwnedNavigationPaths = Object.values(navigationPaths).filter(
      (path) => !pluginOwnedPaths.has(path),
    );
    expect(new Set(Object.values(BUILTIN_TAB_PATHS))).toEqual(
      new Set(hostOwnedNavigationPaths),
    );
  });

  it("keeps exemptions narrow, typed, and backed by observable fallback labels", () => {
    const exemptions = Object.entries(VIEW_OCR_POLICIES)
      .filter((entry) => entry[1].kind === "semantic-exemption")
      .map(([slug, policy]) => ({
        slug,
        applicability:
          policy.kind === "semantic-exemption"
            ? policy.applicability
            : "unreachable",
        reason:
          policy.kind === "semantic-exemption" ? policy.reason : "unreachable",
        fallbackExpectation:
          policy.kind === "semantic-exemption"
            ? policy.fallbackExpectation
            : {},
      }));
    expect(
      exemptions.map(({ slug, applicability }) => ({ slug, applicability })),
    ).toEqual([
      { slug: "builtin-camera", applicability: "native-platform-gated" },
      {
        slug: "plugin-lifeops-live-test-gui",
        applicability: "unregistered-remote-bundle",
      },
      {
        slug: "plugin-cockpit-gui",
        applicability: "unregistered-remote-bundle",
      },
    ]);
    for (const exemption of exemptions) {
      expect(exemption.reason.length).toBeGreaterThan(40);
      expect(
        (exemption.fallbackExpectation.requireAll?.length ?? 0) +
          (exemption.fallbackExpectation.requireAny?.length ?? 0),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("recognizes plugin-owned Contacts by stable empty-state content", () => {
    const policy = resolveViewOcrPolicy("plugin-contacts-gui");
    expect(policy.kind).toBe("expectation");
    if (policy.kind !== "expectation") {
      throw new Error("Expected plugin Contacts to declare an OCR expectation");
    }
    expect(policy.expectation.requireAll).toBeUndefined();
    expect(policy.expectation.requireAny).toEqual([
      "address book",
      "phone, or email",
      "search",
    ]);
  });

  it("recognizes headerless workspaces without accepting unrelated content", () => {
    for (const [slug, text] of [
      ["builtin-apps", "Tasks Apps No apps installed yet"],
      ["builtin-automations", "New Show All (0) Nothing scheduled yet"],
      ["builtin-documents", "Library Add No documents yet"],
      ["builtin-documents", "Library Add All 1 Docs 1 Quarterly Plan.md"],
      [
        "builtin-character-skills",
        "Personality Relationships Skills Experience 0 proposed No learned skills yet",
      ],
      [
        "builtin-experience",
        "Personality Relationships Skills Experience Captured 0",
      ],
      [
        "builtin-vault",
        "Encrypted credentials and references available to this agent",
      ],
    ]) {
      const policy = resolveViewOcrPolicy(slug);
      if (policy.kind !== "expectation")
        throw new Error("Expected a workspace policy");
      expect(
        positiveExpectationMatches(normalize(text), policy.expectation),
        slug,
      ).toBe(true);
      expect(
        positiveExpectationMatches(
          "Settings Wallet Projects",
          policy.expectation,
        ),
        slug,
      ).toBe(false);
      expect(
        positiveExpectationMatches(
          normalize("Loading view"),
          policy.expectation,
        ),
        slug,
      ).toBe(false);
    }
  });

  it("fails closed for an unknown captured slug", () => {
    expect(() => resolveViewOcrPolicy("plugin-newly-registered-gui")).toThrow(
      /No semantic OCR policy declared/,
    );
  });
});
