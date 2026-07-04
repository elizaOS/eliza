// Reusable rendered-geometry tap-target + role/DOM-coherence gate (#10722).
//
// The 44px Apple-HIG touch floor used to be enforced only as a CSS token
// (`--min-touch-target`) plus lint conventions — nothing measured what the
// browser actually laid out, so a control could regress below 44px (the
// ShellBackButton shipped at 36px; the spatial filter chips at ~34px) with the
// whole gate green. `tap-target-geometry.spec.ts` measures the two known
// regression surfaces; THIS spec generalizes that to a REUSABLE gate that walks
// the same canonical built-in view enumeration the interaction-coverage spec
// uses (`./view-routes`), measures REAL `getBoundingClientRect()` geometry for
// every standalone interactive control on a coarse-pointer Pixel-7 viewport, and
// asserts:
//
//   1. every STANDALONE interactive control (icon/label button, role=button/
//      tab/switch/menuitem, standalone link) renders a >=44x44 hit target, and
//   2. role<->DOM-node coherence: an ARIA role must not contradict the node's
//      native semantics, a non-native role=button/link must be keyboard-
//      focusable, and every interactive control must expose an accessible name.
//
// Legitimately-sub-44 controls (inline prose links, native checkbox/radio boxes
// whose <label> is the real tap surface, nested inner controls, off-screen /
// disabled controls) are excluded IN-PAGE with a documented reason and surfaced
// in the report, never silently dropped. Genuinely-under-44 standalone controls
// that survive the exception filter are FAILURES — fix the source (raise the
// control to the floor) or add a justified entry to `DOCUMENTED_EXCEPTIONS`.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { devices, expect, type Page, test } from "@playwright/test";
import {
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { VIEW_ROUTES } from "./view-routes";

// Coarse-pointer mobile emulation: the `@media (pointer: coarse)` touch floor
// only applies on touch devices, and that is exactly the class of device where
// tap-target size matters. Pixel 7 keeps parity with the shipped Capacitor
// Android WebView viewport the interaction specs already exercise.
test.use({ ...devices["Pixel 7"] });

/** Apple HIG floor, with 0.5px slack for sub-pixel layout rounding. */
const MIN_TAP_PX = 44 - 0.5;

// Machine-readable run report (per-view control records + violation counts),
// written under the package cwd alongside the other Playwright artifacts.
const REPORT_DIR = path.resolve("test-results", "tap-target-geometry");

type ControlKind = "geometry" | "coherence";

type ControlRecord = {
  view: string;
  descriptor: string;
  width: number;
  height: number;
  status: "pass" | "violation" | "exception";
  kind: ControlKind;
  reason: string;
};

/**
 * Documented per-view exceptions for controls that survive the in-page filters
 * but are known-acceptable below the floor. Keyed by view id; each entry is a
 * substring/regex match against the control descriptor plus a written reason.
 * Empty until a real run proves a control genuinely warrants an exception —
 * every entry is a decision on the record, not a silent skip.
 */
const DOCUMENTED_EXCEPTIONS: Record<
  string,
  ReadonlyArray<{ match: RegExp; reason: string }>
> = {};

/**
 * Collect, classify, and (in-page) exception-filter every interactive control
 * in the current view. Runs entirely in the page so geometry + computed style +
 * ancestry are read in a single round trip.
 */
async function collectControls(
  page: Page,
  view: string,
): Promise<ControlRecord[]> {
  const raw = await page.evaluate(
    ({ minTap }) => {
      const INTERACTIVE_SELECTOR = [
        "button",
        "[role=button]",
        "[role=tab]",
        "[role=switch]",
        "[role=menuitem]",
        "[role=menuitemcheckbox]",
        "[role=menuitemradio]",
        "[role=option]",
        "[role=link]",
        "[role=checkbox]",
        "[role=radio]",
        "a[href]",
        "input:not([type=hidden])",
        "select",
        "textarea",
        // Agent-surface elements: only the tappable roles. Bare [data-agent-id]
        // also matched role="region" surfaces (default), which are containers
        // and legitimately non-44px.
        "[data-agent-id][data-agent-role=button]",
        "[data-agent-id][data-agent-role=tab]",
      ].join(",");

      const NATIVE_IMPLICIT_ROLE: Record<string, string> = {
        button: "button",
        a: "link",
        // A plain <select> maps to "combobox"; only multiple/size>1 maps to
        // "listbox" (covered via NATIVE_ROLE_OVERRIDES below).
        select: "combobox",
        textarea: "textbox",
      };

      // Explicit roles ARIA-in-HTML permits on each native element even though
      // they differ from the implicit role.
      const NATIVE_ROLE_OVERRIDES: Record<string, readonly string[]> = {
        button: [
          "combobox",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "option",
          "tab",
        ],
        a: [
          "button",
          "tab",
          "menuitem",
          "option",
          "switch",
          "checkbox",
          "radio",
        ],
        select: ["listbox"],
        textarea: ["combobox"],
      };

      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") === 0
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const accessibleName = (el: Element): string => {
        const attr = (n: string) => el.getAttribute(n)?.trim() || "";
        const labelledby = attr("aria-labelledby");
        if (labelledby) {
          const parts = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || "")
            .filter(Boolean);
          if (parts.length) return parts.join(" ");
        }
        const aria = attr("aria-label");
        if (aria) return aria;
        const title = attr("title");
        if (title) return title;
        const htmlEl = el as HTMLElement;
        const text = (htmlEl.innerText || htmlEl.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (text) return text;
        // Form controls take their name from an associated <label>.
        const id = el.getAttribute("id");
        if (id) {
          const label = document.querySelector(
            `label[for="${CSS.escape(id)}"]`,
          );
          const labelText = label?.textContent?.replace(/\s+/g, " ").trim();
          if (labelText) return labelText;
        }
        const parentLabel = el.closest("label");
        const parentLabelText = parentLabel?.textContent
          ?.replace(/\s+/g, " ")
          .trim();
        if (parentLabelText) return parentLabelText;
        const alt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
        if (alt) return alt;
        return "";
      };

      const isFocusable = (el: Element): boolean => {
        const tag = el.tagName.toLowerCase();
        if (
          tag === "button" ||
          tag === "a" ||
          tag === "input" ||
          tag === "select" ||
          tag === "textarea"
        ) {
          return !(el as HTMLButtonElement).disabled;
        }
        const tabindex = el.getAttribute("tabindex");
        if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0)
          return true;
        return (el as HTMLElement).isContentEditable === true;
      };

      const isDisabled = (el: Element): boolean =>
        (el as HTMLButtonElement).disabled === true ||
        el.getAttribute("aria-disabled") === "true";

      const describe = (el: Element, name: string): string => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const type = el.getAttribute("type");
        return [
          tag,
          role ? `role=${role}` : null,
          type ? `type=${type}` : null,
          name ? `name="${name.slice(0, 60)}"` : "name=<none>",
        ]
          .filter(Boolean)
          .join(" ");
      };

      const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
      const results: Array<{
        descriptor: string;
        width: number;
        height: number;
        status: "pass" | "violation" | "exception";
        kind: "geometry" | "coherence";
        reason: string;
      }> = [];

      for (const el of nodes) {
        const name = accessibleName(el);
        const descriptor = describe(el, name);
        const tag = el.tagName.toLowerCase();
        const explicitRole = el.getAttribute("role");
        const type = (el.getAttribute("type") || "").toLowerCase();

        // ── role <-> DOM-node coherence ─────────────────────────────────────
        // A conflicting explicit ARIA role on a native interactive element
        // (e.g. <button role="link">, <a href role="button"> where the redundant
        // role fights the native semantics) confuses AT users. A redundant role
        // that MATCHES the implicit role is allowed.
        const implicit = NATIVE_IMPLICIT_ROLE[tag];
        if (
          explicitRole &&
          implicit &&
          explicitRole !== implicit &&
          !(NATIVE_ROLE_OVERRIDES[tag] ?? []).includes(explicitRole) &&
          // <a> without href has no implicit link role, so an explicit role is fine.
          !(tag === "a" && !el.getAttribute("href"))
        ) {
          results.push({
            descriptor,
            width: 0,
            height: 0,
            status: "violation",
            kind: "coherence",
            reason: `explicit role="${explicitRole}" conflicts with native <${tag}> implicit role="${implicit}"`,
          });
        }
        // A non-native element carrying an interactive role must be keyboard
        // focusable, otherwise it is a mouse-only "fake" control.
        const isNative =
          tag === "button" ||
          tag === "a" ||
          tag === "input" ||
          tag === "select" ||
          tag === "textarea";
        if (
          !isNative &&
          explicitRole &&
          [
            "button",
            "link",
            "tab",
            "switch",
            "menuitem",
            "checkbox",
            "radio",
          ].includes(explicitRole) &&
          isVisible(el) &&
          !isFocusable(el)
        ) {
          results.push({
            descriptor,
            width: 0,
            height: 0,
            status: "violation",
            kind: "coherence",
            reason: `non-native role="${explicitRole}" is not keyboard-focusable (no tabindex>=0)`,
          });
        }
        // Every visible, enabled interactive control needs an accessible name.
        if (isVisible(el) && !isDisabled(el) && !name && type !== "hidden") {
          results.push({
            descriptor,
            width: 0,
            height: 0,
            status: "violation",
            kind: "coherence",
            reason: "interactive control has no accessible name",
          });
        }

        // ── rendered geometry ───────────────────────────────────────────────
        if (!isVisible(el)) continue;
        if (isDisabled(el)) continue;

        const rect = el.getBoundingClientRect();
        const width = Math.round(rect.width * 100) / 100;
        const height = Math.round(rect.height * 100) / 100;

        if (
          tag === "input" &&
          (type === "color" || type === "file") &&
          (el.classList.contains("sr-only") ||
            rect.width <= 1 ||
            rect.height <= 1)
        ) {
          results.push({
            descriptor,
            width,
            height,
            status: "exception",
            kind: "geometry",
            reason: `visually-hidden ${type} input; visible proxy button is the tap surface`,
          });
          continue;
        }

        // Nested inner control: an interactive element inside another
        // interactive element — the OUTER element is the real tap surface.
        const nestedInInteractive = (() => {
          let parent = el.parentElement;
          while (parent) {
            if (parent.matches(INTERACTIVE_SELECTOR)) return true;
            parent = parent.parentElement;
          }
          return false;
        })();
        if (nestedInInteractive) {
          results.push({
            descriptor,
            width,
            height,
            status: "exception",
            kind: "geometry",
            reason:
              "nested inside a larger interactive control (outer is the tap surface)",
          });
          continue;
        }

        // Native checkbox / radio boxes are visually small by spec; the
        // associated <label> (or a wrapping row) is the real tap surface.
        if (tag === "input" && (type === "checkbox" || type === "radio")) {
          results.push({
            descriptor,
            width,
            height,
            status: "exception",
            kind: "geometry",
            reason: `native ${type} box; the associated label is the tap surface`,
          });
          continue;
        }

        // Inline prose link: an <a>/role=link laid out inline inside a run of
        // text. Apple HIG's 44px floor targets standalone controls, not links
        // embedded in a paragraph.
        const style = window.getComputedStyle(el);
        const isLink = tag === "a" || explicitRole === "link";
        const displayInline = style.display.startsWith("inline");
        if (isLink && displayInline) {
          const parent = el.parentElement;
          const parentText = (parent?.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const ownText = ((el as HTMLElement).innerText || "")
            .replace(/\s+/g, " ")
            .trim();
          if (parentText.length > ownText.length + 1) {
            results.push({
              descriptor,
              width,
              height,
              status: "exception",
              kind: "geometry",
              reason:
                "inline link embedded in prose (HIG floor targets standalone controls)",
            });
            continue;
          }
        }

        const meetsFloor = height >= minTap && width >= minTap;
        results.push({
          descriptor,
          width,
          height,
          status: meetsFloor ? "pass" : "violation",
          kind: "geometry",
          reason: meetsFloor
            ? "meets 44px floor"
            : `rendered ${width}x${height}px is below the ${minTap}px floor`,
        });
      }

      return results;
    },
    { minTap: MIN_TAP_PX },
  );

  return raw.map((r) => ({ ...r, view }));
}

function isDocumentedException(view: string, descriptor: string): boolean {
  return (DOCUMENTED_EXCEPTIONS[view] ?? []).some((e) =>
    e.match.test(descriptor),
  );
}

const allRecords: ControlRecord[] = [];

test.describe("tap-target rendered-geometry + role/DOM coherence gate", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
    await hideContinuousChatOverlay(page);
    await installDefaultAppRoutes(page);
  });

  for (const view of VIEW_ROUTES) {
    test(`${view.id} — every standalone control is a >=44px, coherent hit target`, async ({
      page,
    }) => {
      await openAppPath(page, view.path);
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });

      const records = await collectControls(page, view.id);
      allRecords.push(...records);

      expect(
        records.length,
        `${view.id}: expected to enumerate at least one interactive control`,
      ).toBeGreaterThan(0);

      const geometryViolations = records
        .filter((r) => r.kind === "geometry" && r.status === "violation")
        .filter((r) => !isDocumentedException(view.id, r.descriptor));
      const coherenceViolations = records
        .filter((r) => r.kind === "coherence" && r.status === "violation")
        .filter((r) => !isDocumentedException(view.id, r.descriptor));

      expect(
        coherenceViolations,
        [
          `${view.id}: ${coherenceViolations.length} role/DOM coherence violation(s) — fix the a11y defect or document the exception:`,
          ...coherenceViolations.map((r) => `  • ${r.descriptor}: ${r.reason}`),
        ].join("\n"),
      ).toHaveLength(0);

      expect(
        geometryViolations,
        [
          `${view.id}: ${geometryViolations.length} standalone control(s) below the 44px floor — raise them to --min-touch-target or document the exception:`,
          ...geometryViolations.map((r) => `  • ${r.descriptor}: ${r.reason}`),
        ].join("\n"),
      ).toHaveLength(0);
    });
  }

  test.afterAll(() => {
    if (allRecords.length === 0) return;
    mkdirSync(REPORT_DIR, { recursive: true });
    const byView: Record<string, ControlRecord[]> = {};
    for (const r of allRecords) {
      byView[r.view] ??= [];
      byView[r.view].push(r);
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      floorPx: MIN_TAP_PX,
      totalControls: allRecords.length,
      geometryViolations: allRecords.filter(
        (r) => r.kind === "geometry" && r.status === "violation",
      ).length,
      coherenceViolations: allRecords.filter(
        (r) => r.kind === "coherence" && r.status === "violation",
      ).length,
      exceptions: allRecords.filter((r) => r.status === "exception").length,
      byView,
    };
    writeFileSync(
      path.join(REPORT_DIR, "report.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  });
});
