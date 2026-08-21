/**
 * Form interaction helpers for browser workspace click, fill, type, and key commands.
 */

import type { JSDOM } from "jsdom";
import { browserBridgeDomainFromUrl } from "../bridge-policy.js";
import { evaluateBrowserDomainPolicies } from "../browser-domain-policy.js";
import { BrowserDispatchFailure } from "../dispatch-types.js";
import {
  buildBrowserWorkspaceElementSelector,
  findClosestBrowserWorkspaceForm,
} from "./browser-workspace-elements.js";
import {
  assertBrowserWorkspaceUrl,
  inferBrowserWorkspaceTitle,
  normalizeBrowserWorkspaceText,
} from "./browser-workspace-helpers.js";
import {
  createEmptyWebBrowserWorkspaceDom,
  ensureBrowserWorkspaceDom,
  getJSDOMClass,
  installBrowserWorkspaceWebRuntime,
} from "./browser-workspace-jsdom.js";
import { fetchBrowserWorkspaceTrackedResponse } from "./browser-workspace-network.js";
import {
  getBrowserWorkspaceRuntimeState,
  getBrowserWorkspaceTimestamp,
  resetBrowserWorkspaceRuntimeNavigationState,
} from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceScrollDirection,
  WebBrowserWorkspaceTabState,
} from "./browser-workspace-types.js";

/** Redirect hops followed before a submit or navigation is abandoned. */
const MAX_BROWSER_WORKSPACE_REDIRECTS = 10;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * Evaluates registered domain policies against a *resolved* destination URL and
 * throws a typed `POLICY_BLOCKED` failure on any non-allow verdict.
 *
 * Every place the workspace is about to commit bytes or tab state to a concrete
 * URL routes through here: the anchor-click navigation, the form submit target,
 * and each individual redirect hop. Evaluating the pre-redirect URL only is not
 * sufficient — a 307/308 preserves the request body, so the destination must be
 * cleared before the hop is followed, not after.
 */
function assertBrowserWorkspaceUrlAllowed(
  url: string,
  effect: "navigate" | "submit",
  subaction: string,
): void {
  const decision = evaluateBrowserDomainPolicies({
    subaction,
    effect,
    domain: browserBridgeDomainFromUrl(url),
    url,
    targetId: "workspace",
    phase: effect === "submit" ? "submit" : "dispatch",
  });
  if (decision.verdict === "allow") {
    return;
  }
  const label = effect === "submit" ? "form submit" : "navigation";
  throw new BrowserDispatchFailure(
    "POLICY_BLOCKED",
    decision.verdict === "require_confirmation"
      ? `Browser ${label} to "${url}" requires explicit confirmation by domain policy "${decision.policyId}": ${decision.reason}`
      : `Browser ${label} to "${url}" was blocked by domain policy "${decision.policyId}": ${decision.reason}`,
    { targetId: "workspace" },
  );
}

/**
 * Resolves a `Location` header against the URL that produced it, rejecting a
 * redirect whose target is not an absolute http(s) URL.
 */
function resolveRedirectLocation(response: Response, fromUrl: string): string {
  const location = response.headers.get("location")?.trim();
  if (!location) {
    throw new Error(
      `Browser workspace redirect (${response.status}) from "${fromUrl}" has no Location header.`,
    );
  }
  return assertBrowserWorkspaceUrl(new URL(location, fromUrl).toString());
}

export function ensureBrowserWorkspaceFormControlElement(
  element: Element,
  subaction:
    | "clipboard"
    | "fill"
    | "keyboardinserttext"
    | "keyboardtype"
    | "select"
    | "type",
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    return element as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement;
  }

  throw new Error(
    `Eliza browser workspace ${subaction} requires an input, textarea, or select target.`,
  );
}

export function ensureBrowserWorkspaceCheckboxElement(
  element: Element,
  subaction: "check" | "uncheck",
): HTMLInputElement {
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement;
    const type = input.type.trim().toLowerCase();
    if (type === "checkbox" || type === "radio") {
      return input;
    }
  }

  throw new Error(
    `Eliza browser workspace ${subaction} requires a checkbox or radio input target.`,
  );
}

export function setBrowserWorkspaceControlValue(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  nextValue: string,
): void {
  control.value = nextValue;
  if (control.tagName === "TEXTAREA") {
    control.textContent = nextValue;
  }
  control.setAttribute("value", nextValue);
}

export async function activateWebBrowserWorkspaceElement(
  tab: WebBrowserWorkspaceTabState,
  element: Element,
  subaction: "click" | "dblclick",
): Promise<BrowserWorkspaceCommandResult> {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") {
    const href = element.getAttribute("href")?.trim();
    if (!href) {
      throw new Error("Target link does not have an href.");
    }
    const nextUrl = new URL(href, tab.url).toString();
    // Navigation interception (issue #19882): the dispatcher sees a click as
    // effect `interact` with no URL, so an allowlisted page linking to a denied
    // domain would otherwise navigate freely. The resolved href is only known
    // here — gate it before any tab/history mutation or network activity.
    assertBrowserWorkspaceUrlAllowed(nextUrl, "navigate", subaction);
    clearWebBrowserWorkspaceTabElementRefs(tab.id);
    tab.url = assertBrowserWorkspaceUrl(nextUrl);
    tab.title = inferBrowserWorkspaceTitle(tab.url);
    tab.dom = null;
    tab.loadedUrl = null;
    pushWebBrowserWorkspaceHistory(tab, tab.url);
    await loadWebBrowserWorkspaceTabDocument(tab);
    return {
      mode: "web",
      subaction,
      tab: cloneWebBrowserWorkspaceTabState(tab),
      value: {
        clickCount: subaction === "dblclick" ? 2 : 1,
        selector: buildBrowserWorkspaceElementSelector(element),
        url: tab.url,
      },
    };
  }

  const inputElement = tag === "input" ? (element as HTMLInputElement) : null;
  const inputType = inputElement?.type?.toLowerCase() ?? "";
  if (inputElement && (inputType === "checkbox" || inputType === "radio")) {
    inputElement.checked = inputType === "radio" ? true : !inputElement.checked;
    return {
      mode: "web",
      subaction,
      value: {
        checked: inputElement.checked,
        clickCount: subaction === "dblclick" ? 2 : 1,
        selector: buildBrowserWorkspaceElementSelector(element),
      },
    };
  }

  const submitForm = findClosestBrowserWorkspaceForm(element);
  if (
    submitForm &&
    (tag === "form" ||
      tag === "button" ||
      (tag === "input" &&
        ["button", "image", "submit"].includes(inputType || "submit")))
  ) {
    await submitWebBrowserWorkspaceForm(tab, submitForm);
    return {
      mode: "web",
      subaction,
      tab: cloneWebBrowserWorkspaceTabState(tab),
      value: {
        clickCount: subaction === "dblclick" ? 2 : 1,
        selector: buildBrowserWorkspaceElementSelector(element),
        url: tab.url,
      },
    };
  }

  return {
    mode: "web",
    subaction,
    value: {
      clickCount: subaction === "dblclick" ? 2 : 1,
      selector: buildBrowserWorkspaceElementSelector(element),
      text: normalizeBrowserWorkspaceText(element.textContent),
    },
  };
}

export function scrollWebBrowserWorkspaceTarget(
  dom: JSDOM,
  element: Element | null,
  direction: BrowserWorkspaceScrollDirection,
  pixels: number,
): {
  axis: "x" | "y";
  selector: string | null;
  value: number;
} {
  const resolvedPixels = Number.isFinite(pixels)
    ? Math.max(1, Math.abs(pixels))
    : 240;
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const delta =
    direction === "up" || direction === "left"
      ? -resolvedPixels
      : resolvedPixels;

  if (element && element instanceof dom.window.HTMLElement) {
    if (axis === "y") {
      element.scrollTop = (element.scrollTop || 0) + delta;
      return {
        axis,
        selector: buildBrowserWorkspaceElementSelector(element),
        value: element.scrollTop,
      };
    }
    element.scrollLeft = (element.scrollLeft || 0) + delta;
    return {
      axis,
      selector: buildBrowserWorkspaceElementSelector(element),
      value: element.scrollLeft,
    };
  }

  const key = axis === "y" ? "__elizaScrollY" : "__elizaScrollX";
  const current = Number(Reflect.get(dom.window, key) ?? 0);
  const next = current + delta;
  Reflect.set(dom.window, key, next);
  return {
    axis,
    selector: null,
    value: next,
  };
}

export async function submitWebBrowserWorkspaceForm(
  tab: WebBrowserWorkspaceTabState,
  form: HTMLFormElement,
): Promise<void> {
  const state = getBrowserWorkspaceRuntimeState("web", tab.id);
  const dom = ensureBrowserWorkspaceDom(tab);
  const action = form.getAttribute("action")?.trim() || tab.url;
  const method = (form.getAttribute("method")?.trim() || "get").toLowerCase();
  const submitUrl = new URL(action, tab.url).toString();
  // Submit interception (issue #19882): the resolved submit URL is only known
  // here, after the form's action/base resolution — so per-domain policies get
  // their authoritative check at this exact point, before any bytes leave.
  assertBrowserWorkspaceUrlAllowed(submitUrl, "submit", "click");
  const formData = new dom.window.FormData(form);
  const searchParams = new URLSearchParams();

  for (const [key, value] of formData.entries()) {
    searchParams.append(key, String(value));
  }

  if (method === "get") {
    const nextUrl = new URL(submitUrl);
    nextUrl.search = searchParams.toString();
    clearWebBrowserWorkspaceTabElementRefs(tab.id);
    tab.url = nextUrl.toString();
    tab.title = inferBrowserWorkspaceTitle(tab.url);
    tab.dom = null;
    tab.loadedUrl = null;
    pushWebBrowserWorkspaceHistory(tab, tab.url);
    await loadWebBrowserWorkspaceTabDocument(tab);
    return;
  }

  // Redirects are followed manually so every resolved destination is policy
  // checked before the hop is taken. A 307/308 replays the form body verbatim,
  // so an allowed endpoint must not be able to hand those bytes to a denied
  // domain by redirecting after the single pre-flight check.
  let requestUrl = submitUrl;
  let requestMethod = method.toUpperCase();
  let requestBody: string | null = searchParams.toString();
  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_BROWSER_WORKSPACE_REDIRECTS; hop += 1) {
    const hopInit: RequestInit = {
      method: requestMethod,
      redirect: "manual",
    };
    if (requestBody !== null) {
      hopInit.body = requestBody;
      hopInit.headers = {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      };
    }
    const hopResponse = await fetchBrowserWorkspaceTrackedResponse(
      state,
      requestUrl,
      hopInit,
      "document",
    );
    if (!REDIRECT_STATUSES.has(hopResponse.status)) {
      response = hopResponse;
      break;
    }
    if (hop === MAX_BROWSER_WORKSPACE_REDIRECTS) {
      throw new Error(
        `Browser workspace form submit exceeded ${MAX_BROWSER_WORKSPACE_REDIRECTS} redirects: ${submitUrl}`,
      );
    }
    const nextUrl = resolveRedirectLocation(hopResponse, requestUrl);
    // 307/308 preserve method and body, so the next hop is still a submit.
    // 301/302/303 degrade a POST to a bodyless GET, which is a navigation.
    const preservesBody =
      (hopResponse.status === 307 || hopResponse.status === 308) &&
      requestBody !== null;
    assertBrowserWorkspaceUrlAllowed(
      nextUrl,
      preservesBody ? "submit" : "navigate",
      "click",
    );
    requestUrl = nextUrl;
    if (!preservesBody) {
      requestMethod = "GET";
      requestBody = null;
    }
  }

  if (!response) {
    throw new Error(
      `Browser workspace form submit produced no response: ${submitUrl}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Browser workspace form submit failed (${response.status}): ${submitUrl}`,
    );
  }

  const html = await response.text();
  const finalUrl = assertBrowserWorkspaceUrl(
    response.url?.trim() || requestUrl,
  );
  if (finalUrl !== requestUrl) {
    assertBrowserWorkspaceUrlAllowed(finalUrl, "navigate", "click");
  }
  const nextDom = new (getJSDOMClass())(html, {
    pretendToBeVisual: true,
    url: finalUrl,
  });
  installBrowserWorkspaceWebRuntime(tab, nextDom);
  resetBrowserWorkspaceRuntimeNavigationState(state);
  clearWebBrowserWorkspaceTabElementRefs(tab.id);
  tab.url = finalUrl;
  tab.dom = nextDom;
  tab.loadedUrl = finalUrl;
  tab.title =
    normalizeBrowserWorkspaceText(nextDom.window.document.title) ||
    inferBrowserWorkspaceTitle(finalUrl);
  tab.updatedAt = getBrowserWorkspaceTimestamp();
  pushWebBrowserWorkspaceHistory(tab, finalUrl);
}

// --- Web tab helpers that forms/activation need ---

import { clearBrowserWorkspaceElementRefs } from "./browser-workspace-state.js";
import type { BrowserWorkspaceTab } from "./browser-workspace-types.js";

export function clearWebBrowserWorkspaceTabElementRefs(tabId: string): void {
  clearBrowserWorkspaceElementRefs("web", tabId);
}

export function cloneWebBrowserWorkspaceTabState(
  tab: WebBrowserWorkspaceTabState,
): BrowserWorkspaceTab {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    partition: tab.partition,
    kind: tab.kind,
    visible: tab.visible,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    lastFocusedAt: tab.lastFocusedAt,
  };
}

export function pushWebBrowserWorkspaceHistory(
  tab: WebBrowserWorkspaceTabState,
  nextUrl: string,
): void {
  const nextHistory = tab.history.slice(0, tab.historyIndex + 1);
  nextHistory.push(nextUrl);
  tab.history = nextHistory;
  tab.historyIndex = nextHistory.length - 1;
}

export async function loadWebBrowserWorkspaceTabDocument(
  tab: WebBrowserWorkspaceTabState,
): Promise<void> {
  const state = getBrowserWorkspaceRuntimeState("web", tab.id);
  if (tab.url === "about:blank") {
    tab.dom = createEmptyWebBrowserWorkspaceDom(tab.url);
    installBrowserWorkspaceWebRuntime(tab, tab.dom);
    tab.loadedUrl = tab.url;
    tab.title = "New Tab";
    tab.updatedAt = getBrowserWorkspaceTimestamp();
    return;
  }

  // Redirect hops are taken manually so a policy-cleared page cannot bounce the
  // tab onto a denied domain after the fact; each destination is re-evaluated
  // as a navigation before it is requested.
  let requestUrl = tab.url;
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_BROWSER_WORKSPACE_REDIRECTS; hop += 1) {
    const hopResponse = await fetchBrowserWorkspaceTrackedResponse(
      state,
      requestUrl,
      { redirect: "manual" },
      "document",
    );
    if (!REDIRECT_STATUSES.has(hopResponse.status)) {
      response = hopResponse;
      break;
    }
    if (hop === MAX_BROWSER_WORKSPACE_REDIRECTS) {
      throw new Error(
        `Browser workspace web load exceeded ${MAX_BROWSER_WORKSPACE_REDIRECTS} redirects: ${tab.url}`,
      );
    }
    const nextUrl = resolveRedirectLocation(hopResponse, requestUrl);
    assertBrowserWorkspaceUrlAllowed(nextUrl, "navigate", "open");
    requestUrl = nextUrl;
  }

  if (!response) {
    throw new Error(
      `Browser workspace web load produced no response: ${tab.url}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Browser workspace web load failed (${response.status}): ${tab.url}`,
    );
  }

  const html = await response.text();
  const finalUrl = assertBrowserWorkspaceUrl(
    response.url?.trim() || requestUrl,
  );
  if (finalUrl !== tab.url) {
    assertBrowserWorkspaceUrlAllowed(finalUrl, "navigate", "open");
  }
  const dom = new (getJSDOMClass())(html, {
    pretendToBeVisual: true,
    url: finalUrl,
  });
  installBrowserWorkspaceWebRuntime(tab, dom);
  resetBrowserWorkspaceRuntimeNavigationState(state);

  tab.dom = dom;
  tab.loadedUrl = finalUrl;
  tab.url = finalUrl;
  tab.title =
    normalizeBrowserWorkspaceText(dom.window.document.title) ||
    inferBrowserWorkspaceTitle(finalUrl);
  tab.updatedAt = getBrowserWorkspaceTimestamp();
  tab.history[tab.historyIndex] = finalUrl;
}

export async function ensureLoadedWebBrowserWorkspaceTabDocument(
  tab: WebBrowserWorkspaceTabState,
): Promise<JSDOM> {
  if (!tab.dom || tab.loadedUrl !== tab.url) {
    await loadWebBrowserWorkspaceTabDocument(tab);
  }
  return ensureBrowserWorkspaceDom(tab);
}
