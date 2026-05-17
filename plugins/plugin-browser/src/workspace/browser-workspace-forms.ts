import type { JSDOM } from "jsdom";
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

  const response = await fetchBrowserWorkspaceTrackedResponse(
    state,
    submitUrl,
    {
      body: searchParams.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      method: method.toUpperCase(),
    },
    "document",
  );

  if (!response.ok) {
    throw new Error(
      `Browser workspace form submit failed (${response.status}): ${submitUrl}`,
    );
  }

  const html = await response.text();
  const finalUrl = assertBrowserWorkspaceUrl(response.url?.trim() || submitUrl);
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
  const { createEmptyWebBrowserWorkspaceDom } = await import(
    "./browser-workspace-jsdom.js"
  );
  if (tab.url === "about:blank") {
    tab.dom = createEmptyWebBrowserWorkspaceDom(tab.url);
    installBrowserWorkspaceWebRuntime(tab, tab.dom);
    tab.loadedUrl = tab.url;
    tab.title = "New Tab";
    tab.updatedAt = getBrowserWorkspaceTimestamp();
    return;
  }

  const response = await fetchBrowserWorkspaceTrackedResponse(
    state,
    tab.url,
    {},
    "document",
  );
  if (!response.ok) {
    throw new Error(
      `Browser workspace web load failed (${response.status}): ${tab.url}`,
    );
  }

  const html = await response.text();
  const finalUrl = assertBrowserWorkspaceUrl(response.url?.trim() || tab.url);
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
