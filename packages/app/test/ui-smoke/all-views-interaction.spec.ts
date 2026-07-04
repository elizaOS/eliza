/**
 * Playwright UI-smoke spec for the All Views Interaction app flow using the
 * real renderer fixture.
 */
import {
  type ElementHandle,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import {
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { VIEW_ROUTES } from "./view-routes";

/**
 * Generic per-view interaction coverage (#8796).
 *
 * builtin-views-visual.spec only asserts each view *boots*; this spec drives
 * every interactive control in every built-in view — clicking each button /
 * menu item / tab / link and filling each text input — then asserts each
 * interaction has an observable semantic outcome in addition to the page-error
 * guard. It's the automatable form of "every button, input, menu, dropdown
 * works for every view": instead of hand-writing assertions per control, it
 * enumerates the real controls at runtime and exercises them. Run with
 * E2E_RECORD=1 for video.
 *
 * Clicks that navigate away are recovered by re-opening the route, so one
 * navigation doesn't end coverage of the rest of the page.
 */
// Bound per-view work so the suite stays under the playwright timeout while
// still exercising a representative breadth of controls.
const MAX_CLICKS = 24;
const MAX_INPUTS = 8;

const CLICK_SELECTOR =
  "button:visible, [role='button']:visible, [role='tab']:visible, [role='menuitem']:visible, a[href^='#']:visible";
const INPUT_SELECTOR =
  "input:visible:not([type='file']):not([disabled]), textarea:visible:not([disabled])";

type SemanticResult = {
  kind: "observed" | "documented-noop" | "failure";
  message: string;
};

type ControlDetails = {
  tagName: string;
  role: string | null;
  type: string | null;
  href: string | null;
  label: string;
  text: string;
  value: string | null;
  checked: boolean | null;
  attributes: Record<string, string | null>;
};

type ControlSnapshot = {
  url: string;
  apiRequestCount: number;
  visibleDismissibleSurfaces: number;
  details: ControlDetails | null;
};

const CLICK_OBSERVED_ATTRIBUTES = [
  "aria-expanded",
  "aria-pressed",
  "aria-selected",
  "aria-current",
  "data-state",
  "data-open",
  "data-active",
  "data-selected",
  "data-value",
  "open",
] as const;

function truncate(value: string, maxLength = 80): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

async function numericInputValue(input: Locator): Promise<string> {
  return input.evaluate((el: Element) => {
    const inputEl = el as HTMLInputElement;
    const min = Number.parseFloat(inputEl.min);
    const max = Number.parseFloat(inputEl.max);
    let next = 42;
    if (Number.isFinite(min) && next < min) next = min;
    if (Number.isFinite(max) && next > max) next = max;
    return String(next);
  });
}

async function fillOrToggleInput(
  input: Locator,
  index: number,
): Promise<SemanticResult> {
  const tagName = ((await input.evaluate((el: Element) => el.tagName)) ?? "")
    .toString()
    .toLowerCase();
  const type = ((await input.getAttribute("type")) ?? "text").toLowerCase();
  const label = (
    [
      await input.getAttribute("aria-label"),
      await input.getAttribute("name"),
      await input.getAttribute("placeholder"),
      await input.getAttribute("autocomplete"),
    ]
      .filter(Boolean)
      .join(" ") || ""
  ).toLowerCase();
  if (tagName === "textarea") {
    const value = `smoke textarea ${index}`;
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: textarea value round-tripped`,
    };
  }
  if (type === "checkbox" || type === "radio") {
    const wasChecked = await input.isChecked();
    await input.click();
    if (type === "radio" && wasChecked) {
      await expect(input).toBeChecked();
      return {
        kind: "documented-noop",
        message: `input ${index}: already-selected radio stayed selected`,
      };
    }
    if (wasChecked) {
      await expect(input).not.toBeChecked();
    } else {
      await expect(input).toBeChecked();
    }
    return {
      kind: "observed",
      message: `input ${index}: ${type} checked state changed`,
    };
  }
  if (type === "number" || type === "range") {
    const value = await numericInputValue(input);
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: ${type} value round-tripped`,
    };
  }
  if (type === "color") {
    // A color input only accepts a valid #rrggbb value — filling arbitrary text
    // (e.g. the Custom background color picker) throws "Malformed value".
    const value = "#3366ff";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: color value round-tripped`,
    };
  }
  if (type === "email" || label.includes("email")) {
    const value = "smoke@example.com";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: email value round-tripped`,
    };
  }
  if (type === "url" || label.includes("url")) {
    const value = "https://example.com";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: url value round-tripped`,
    };
  }
  if (type === "date") {
    const value = "2026-06-29";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: date value round-tripped`,
    };
  }
  if (type === "datetime-local") {
    const value = "2026-06-29T12:00";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: datetime value round-tripped`,
    };
  }
  if (type === "time") {
    const value = "12:00";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: time value round-tripped`,
    };
  }
  if (type === "month") {
    const value = "2026-06";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: month value round-tripped`,
    };
  }
  if (type === "week") {
    const value = "2026-W27";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: week value round-tripped`,
    };
  }
  if (type === "tel" || label.includes("phone")) {
    const value = "5550100";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: phone value round-tripped`,
    };
  }
  if (type === "password") {
    const value = "smoke-password";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: password value round-tripped`,
    };
  }
  if (type === "search" || label.includes("search")) {
    const value = "smoke";
    await input.fill(value);
    await expect(input).toHaveValue(value);
    return {
      kind: "observed",
      message: `input ${index}: search value round-tripped`,
    };
  }
  const value = `smoke input ${index}`;
  await input.fill(value);
  await expect(input).toHaveValue(value);
  return {
    kind: "observed",
    message: `input ${index}: text value round-tripped`,
  };
}

async function isPointerReachable(control: Locator): Promise<boolean> {
  return control.evaluate((el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return top === el || (top ? el.contains(top) : false);
  });
}

async function visibleDismissibleSurfaceCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selector = [
      '[role="alertdialog"]',
      '[role="dialog"]',
      '[role="listbox"]',
      '[role="menu"]',
      '[role="tree"]',
      "dialog[open]",
      "[data-radix-popper-content-wrapper]",
    ].join(",");
    return Array.from(document.querySelectorAll(selector)).filter((el) => {
      const node = el as HTMLElement;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }).length;
  });
}

async function snapshotControl(
  page: Page,
  control: ElementHandle<Element>,
  apiRequestCount: number,
): Promise<ControlSnapshot> {
  const details = await control
    .evaluate((el: Element, observedAttributes: readonly string[]) => {
      const htmlEl = el as HTMLElement;
      const inputEl = el as HTMLInputElement;
      const anchorEl = el as HTMLAnchorElement;
      const attr = (name: string): string | null => el.getAttribute(name);
      const text = (htmlEl.innerText || htmlEl.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const label =
        attr("aria-label") || attr("title") || attr("data-testid") || text;
      const attributes = Object.fromEntries(
        observedAttributes.map((name) => [name, attr(name)]),
      ) as Record<string, string | null>;
      return {
        tagName: el.tagName.toLowerCase(),
        role: attr("role"),
        type: attr("type"),
        href: "href" in anchorEl ? anchorEl.href : null,
        label: label ? label.slice(0, 120) : "",
        text: text.slice(0, 120),
        value: "value" in inputEl ? String(inputEl.value) : null,
        checked: "checked" in inputEl ? Boolean(inputEl.checked) : null,
        attributes,
      };
    }, CLICK_OBSERVED_ATTRIBUTES)
    .catch(() => null);

  return {
    url: page.url(),
    apiRequestCount,
    visibleDismissibleSurfaces: await visibleDismissibleSurfaceCount(page),
    details,
  };
}

function describeControl(details: ControlDetails | null): string {
  if (!details) return "detached control";
  return truncate(
    [
      details.tagName,
      details.role ? `role=${details.role}` : null,
      details.type ? `type=${details.type}` : null,
      details.label ? `label="${details.label}"` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function semanticDelta(
  before: ControlSnapshot,
  after: ControlSnapshot,
): string | null {
  if (after.url !== before.url) {
    return `URL changed from ${before.url} to ${after.url}`;
  }
  if (after.apiRequestCount > before.apiRequestCount) {
    return `API request count changed ${before.apiRequestCount} -> ${after.apiRequestCount}`;
  }
  if (after.visibleDismissibleSurfaces !== before.visibleDismissibleSurfaces) {
    return `dismissible surface count changed ${before.visibleDismissibleSurfaces} -> ${after.visibleDismissibleSurfaces}`;
  }
  if (before.details && !after.details) {
    return "clicked control detached or was replaced";
  }
  if (!before.details || !after.details) {
    return null;
  }
  if (after.details.label !== before.details.label) {
    return `control label changed from "${before.details.label}" to "${after.details.label}"`;
  }
  if (after.details.text !== before.details.text) {
    return `control text changed from "${truncate(before.details.text)}" to "${truncate(after.details.text)}"`;
  }
  if (after.details.checked !== before.details.checked) {
    return `checked state changed ${String(before.details.checked)} -> ${String(after.details.checked)}`;
  }
  if (after.details.value !== before.details.value) {
    return `value changed from "${String(before.details.value)}" to "${String(after.details.value)}"`;
  }
  for (const attr of CLICK_OBSERVED_ATTRIBUTES) {
    if (after.details.attributes[attr] !== before.details.attributes[attr]) {
      return `${attr} changed from "${String(before.details.attributes[attr])}" to "${String(after.details.attributes[attr])}"`;
    }
  }
  return null;
}

function documentedClickNoop(
  before: ControlSnapshot,
  after: ControlSnapshot,
): string | null {
  const details = before.details;
  if (!details) return null;
  const label =
    `${details.role ?? ""} ${details.type ?? ""} ${details.label} ${details.text}`.toLowerCase();
  if (
    details.role === "tab" &&
    details.attributes["aria-selected"] === "true" &&
    after.details?.attributes["aria-selected"] === "true"
  ) {
    return "active tab re-selection leaves the selected tab unchanged";
  }
  if (details.href) {
    try {
      const beforeUrl = new URL(before.url);
      const hrefUrl = new URL(details.href);
      if (
        hrefUrl.pathname === beforeUrl.pathname &&
        hrefUrl.hash === beforeUrl.hash
      ) {
        return "same-route hash link is already selected";
      }
    } catch {
      /* malformed hrefs are not expected in the app shell */
    }
  }
  if (
    /\b(upload|choose file|select file|attach|download|copy|microphone|camera|record|voice|share)\b/.test(
      label,
    )
  ) {
    return "browser-native file, device, clipboard, or download affordance has no DOM outcome without choosing a file/device";
  }
  if (
    /\b(back|close|cancel|dismiss)\b/.test(label) &&
    before.visibleDismissibleSurfaces === 0
  ) {
    return "dismiss/back control had no visible overlay or modal to close";
  }
  return null;
}

async function observeClickOutcome(
  page: Page,
  control: ElementHandle<Element>,
  before: ControlSnapshot,
  apiRequestCount: () => number,
): Promise<SemanticResult> {
  let after = await snapshotControl(page, control, apiRequestCount());
  let delta = semanticDelta(before, after);
  for (const delayMs of [100, 250, 500]) {
    if (delta) {
      return {
        kind: "observed",
        message: `${describeControl(before.details)}: ${delta}`,
      };
    }
    await page.waitForTimeout(delayMs);
    after = await snapshotControl(page, control, apiRequestCount());
    delta = semanticDelta(before, after);
  }
  if (delta) {
    return {
      kind: "observed",
      message: `${describeControl(before.details)}: ${delta}`,
    };
  }
  const noopReason = documentedClickNoop(before, after);
  if (noopReason) {
    return {
      kind: "documented-noop",
      message: `${describeControl(before.details)}: ${noopReason}`,
    };
  }
  return {
    kind: "failure",
    message: `${describeControl(before.details)} produced no URL, API, DOM state, dialog/menu, value, checked, text, or documented no-op outcome`,
  };
}

async function pressEscapeWithSemanticOutcome(
  page: Page,
  descriptor: string,
): Promise<SemanticResult> {
  const beforeCount = await visibleDismissibleSurfaceCount(page);
  const beforeUrl = page.url();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const afterCount = await visibleDismissibleSurfaceCount(page);
  if (afterCount < beforeCount) {
    return {
      kind: "observed",
      message: `${descriptor}: Escape dismissed a visible surface`,
    };
  }
  if (page.url() !== beforeUrl) {
    return {
      kind: "observed",
      message: `${descriptor}: Escape changed the URL from ${beforeUrl} to ${page.url()}`,
    };
  }
  if (beforeCount === 0) {
    return {
      kind: "documented-noop",
      message: `${descriptor}: Escape had no visible dialog, menu, listbox, or popover to dismiss`,
    };
  }
  return {
    kind: "failure",
    message: `${descriptor}: Escape did not dismiss ${beforeCount} visible dismissible surface(s)`,
  };
}

test.describe("every-view interaction coverage", () => {
  for (const view of VIEW_ROUTES) {
    test(`${view.id} — exercise every control with semantic outcomes`, async ({
      page,
    }) => {
      const pageErrors: string[] = [];
      const actionFailures: string[] = [];
      const networkFailures: string[] = [];
      const semanticFailures: string[] = [];
      const semanticOutcomes: string[] = [];
      const documentedNoops: string[] = [];
      const apiRequests: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith("/api/")) {
          apiRequests.push(`${request.method()} ${pathname}`);
        }
      });
      page.on("response", (response) => {
        const status = response.status();
        if (status < 500) return;
        const pathname = new URL(response.url()).pathname;
        if (pathname.startsWith("/api/")) {
          networkFailures.push(`http ${status}: ${pathname}`);
        }
      });
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return;
        const failureText = request.failure()?.errorText ?? "";
        if (failureText === "net::ERR_ABORTED") return;
        networkFailures.push(`requestfailed: ${url} ${failureText}`);
      });

      await page.setViewportSize({ width: 1440, height: 1000 });
      await seedAppStorage(page);
      await hideContinuousChatOverlay(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, view.path);
      await page.locator("body").waitFor({ state: "visible", timeout: 60_000 });
      semanticOutcomes.push(
        `view ${view.id}: route ${view.path} rendered ${page.url()}`,
      );

      // Fill text inputs first (some controls become enabled once filled).
      const inputs = page.locator(INPUT_SELECTOR);
      const inputCount = Math.min(await inputs.count(), MAX_INPUTS);
      for (let i = 0; i < inputCount; i += 1) {
        const input = inputs.nth(i);
        try {
          const result = await fillOrToggleInput(input, i);
          if (result.kind === "failure") {
            semanticFailures.push(result.message);
          } else if (result.kind === "documented-noop") {
            documentedNoops.push(result.message);
          } else {
            semanticOutcomes.push(result.message);
          }
        } catch (error) {
          actionFailures.push(
            `input ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Snapshot clickable controls by accessible name, then click each by name
      // so re-renders/navigation don't invalidate positional handles.
      const clickables = page.locator(CLICK_SELECTOR);
      const clickCount = Math.min(await clickables.count(), MAX_CLICKS);
      for (let i = 0; i < clickCount; i += 1) {
        const liveControls = page.locator(CLICK_SELECTOR);
        if (i >= (await liveControls.count())) {
          break;
        }
        const control = liveControls.nth(i);
        if (!(await control.isVisible().catch(() => false))) {
          continue;
        }
        if (!(await isPointerReachable(control).catch(() => false))) {
          continue;
        }
        const controlHandle = await control.elementHandle();
        if (!controlHandle) {
          continue;
        }
        const before = await snapshotControl(
          page,
          controlHandle,
          apiRequests.length,
        );
        try {
          await control.click({ noWaitAfter: true, timeout: 2_000 });
        } catch (error) {
          actionFailures.push(
            `click ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
          await controlHandle.dispose();
          continue;
        }
        const result = await observeClickOutcome(
          page,
          controlHandle,
          before,
          () => apiRequests.length,
        );
        await controlHandle.dispose();
        if (result.kind === "failure") {
          semanticFailures.push(`click ${i}: ${result.message}`);
        } else if (result.kind === "documented-noop") {
          documentedNoops.push(`click ${i}: ${result.message}`);
        } else {
          semanticOutcomes.push(`click ${i}: ${result.message}`);
        }
        // If a click navigated away from the view, return to keep exercising it.
        if (!page.url().includes(view.path) && view.path !== "/") {
          try {
            await openAppPath(page, view.path);
          } catch (error) {
            actionFailures.push(
              `recover ${i}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // Dismiss any opened overlay/menu so the next control is reachable.
        try {
          const escapeResult = await pressEscapeWithSemanticOutcome(
            page,
            `click ${i}`,
          );
          if (escapeResult.kind === "failure") {
            semanticFailures.push(escapeResult.message);
          } else if (escapeResult.kind === "documented-noop") {
            documentedNoops.push(escapeResult.message);
          } else {
            semanticOutcomes.push(escapeResult.message);
          }
        } catch (error) {
          actionFailures.push(
            `escape ${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      expect(
        semanticFailures,
        [
          `${view.id}: every exercised input/click/Escape interaction needs an observable semantic outcome or an explicit documented no-op`,
          ...semanticFailures,
        ].join("\n"),
      ).toHaveLength(0);
      expect(
        semanticOutcomes.length + documentedNoops.length,
        `${view.id}: expected semantic assertions for at least one enumerated interaction`,
      ).toBeGreaterThan(0);
      // The contract: no interaction in this view caused an uncaught crash.
      expect(
        [...pageErrors, ...actionFailures, ...networkFailures],
        [
          `${view.id}: a control interaction threw an uncaught error`,
          ...pageErrors,
          ...actionFailures,
          ...networkFailures,
        ].join("\n"),
      ).toHaveLength(0);
    });
  }
});
