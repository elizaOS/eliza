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
  evaluateOcrContent,
  type OcrResult,
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

function ocr(text: string, over: Partial<OcrResult> = {}): OcrResult {
  return {
    ok: true,
    text,
    lines: text.split("\n").filter(Boolean),
    words: text.split(/\s+/).filter(Boolean).length,
    meanConfidence: 1,
    ...over,
  };
}

function mapsExpectation() {
  const policy = resolveViewOcrPolicy("plugin-maps-gui");
  if (policy.kind !== "expectation") {
    throw new Error("Expected plugin Maps to declare an OCR expectation");
  }
  return policy.expectation;
}

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
      "/apps/relationships",
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

  it("keeps separate connected and signed-out Cloud semantic contracts", () => {
    expect(resolveViewOcrPolicy("plugin-cloud-gui")).toEqual({
      kind: "expectation",
      expectation: {
        requireAll: ["Eliza Cloud"],
        requireAny: ["Credits", "Hosted agents", "API keys", "Connected"],
      },
    });
    expect(resolveViewOcrPolicy("plugin-cloud-signed-out-gui")).toEqual({
      kind: "expectation",
      expectation: {
        requireAll: ["Eliza Cloud", "Connect in Settings"],
        requireAny: [
          "credits",
          "hosted agents",
          "API keys",
          "billing",
          "Connect in Settings",
        ],
      },
    });
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

  it("accepts the recorded Maps landscape OCR through stable semantic anchors", () => {
    const finding = evaluateOcrContent({
      ocr: ocr(
        "EXPLORE - PROVIDER-NEUTRAL MAP / MOPS Find somewhere worth going",
        { meanConfidence: 0.71, pixelBlank: false },
      ),
      expectation: mapsExpectation(),
    });

    expect(finding.verdict).toBe("verified");
    expect(finding.missingRequired).toEqual([]);
    expect(finding.forbiddenPresent).toEqual([]);
  });

  it("still rejects blank and wrong-view Maps captures", () => {
    const blank = evaluateOcrContent({
      ocr: ocr("", {
        words: 0,
        meanConfidence: 0,
        pixelBlank: true,
        pixelBlankReasons: ["screenshot is one color"],
      }),
      expectation: mapsExpectation(),
    });
    expect(blank.verdict).toBe("broken");
    expect(blank.blankPixels).toBe(true);

    const wrongView = evaluateOcrContent({
      ocr: ocr("Calendar Upcoming events Today", { pixelBlank: false }),
      expectation: mapsExpectation(),
    });
    expect(wrongView.verdict).toBe("broken");
    expect(wrongView.missingRequired).toEqual([
      "Find somewhere worth going",
      "provider-neutral | Search a place",
    ]);
  });

  it("still rejects developer residue in an otherwise healthy Maps capture", () => {
    const finding = evaluateOcrContent({
      ocr: ocr(
        "MOPS Find somewhere worth going provider-neutral [object Object]",
      ),
      expectation: mapsExpectation(),
    });

    expect(finding.verdict).toBe("broken");
    expect(finding.errorLeaks).toContain("[object Object]");
  });

  it.each(["Google Maps", "Mapbox"])(
    "keeps the %s provider leak out of the verified Maps lane",
    (provider) => {
      const finding = evaluateOcrContent({
        ocr: ocr(
          `MOPS Find somewhere worth going provider-neutral ${provider}`,
        ),
        expectation: mapsExpectation(),
      });

      expect(finding.verdict).toBe("needs-eyeball");
      expect(finding.forbiddenPresent).toEqual([provider]);
    },
  );

  it("fails closed for an unknown captured slug", () => {
    expect(() => resolveViewOcrPolicy("plugin-newly-registered-gui")).toThrow(
      /No semantic OCR policy declared/,
    );
  });
});
