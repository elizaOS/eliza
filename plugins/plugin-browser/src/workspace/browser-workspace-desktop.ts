/**
 * Desktop browser workspace client for forwarding commands to the embedded BrowserView.
 */

import { BrowserDispatchFailure } from "../dispatch-types.js";
import { createBrowserWorkspaceError } from "./browser-workspace-errors.js";
import {
  assertBrowserWorkspaceConnectorSecretsNotExported,
  assertBrowserWorkspaceUserScriptAllowed,
  BROWSER_WORKSPACE_PRIVATE_CONTROL_SCRIPT,
  BROWSER_WORKSPACE_UPLOAD_UNAVAILABLE,
  createBrowserWorkspaceCommandTargetError,
  createBrowserWorkspaceUnknownElementRefError,
  DEFAULT_TIMEOUT_MS,
  isBrowserWorkspaceUserScriptAllowed,
  normalizeEnvValue,
  resolveBrowserCommandTimeoutMs,
  resolveBrowserWorkspaceCommandElementRefs,
} from "./browser-workspace-helpers.js";
import {
  appendBrowserWorkspaceProfilerEntry,
  appendBrowserWorkspaceTraceEntry,
  browserWorkspaceClipboardText,
  getBrowserWorkspaceRuntimeState,
  noteBrowserWorkspaceDocumentUrl,
  registerBrowserWorkspaceElementRefs,
  setBrowserWorkspaceClipboardText,
} from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceBridgeConfig,
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceDomElementSummary,
  BrowserWorkspaceSnapshotRecord,
  BrowserWorkspaceTab,
  EvaluateBrowserWorkspaceTabRequest,
} from "./browser-workspace-types.js";

async function assertDesktopBrowserWorkspaceCanAccessProfileSecrets(
  id: string,
  env: NodeJS.ProcessEnv,
  operation: string,
): Promise<void> {
  const payload = await requestBrowserWorkspace<{
    tabs?: BrowserWorkspaceTab[];
  }>("/tabs", undefined, env);
  const tab = payload.tabs?.find((entry) => entry.id === id) ?? null;
  assertBrowserWorkspaceConnectorSecretsNotExported(tab?.partition, operation);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

export function resolveBrowserWorkspaceBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserWorkspaceBridgeConfig | null {
  const baseUrl = normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_URL);
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/{1,1024}$/, ""),
    token: normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_TOKEN),
  };
}

export function isBrowserWorkspaceBridgeConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveBrowserWorkspaceBridgeConfig(env) !== null;
}

export function getBrowserWorkspaceUnavailableMessage(): string {
  return "Eliza browser workspace desktop bridge is unavailable.";
}

export async function requestBrowserWorkspace<T>(
  path: string,
  init?: RequestInit,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const config = resolveBrowserWorkspaceBridgeConfig(env);
  if (!config) {
    throw createBrowserWorkspaceError(
      "desktop_only",
      "desktop_bridge",
      getBrowserWorkspaceUnavailableMessage(),
    );
  }

  const headers = new Headers(init?.headers ?? {});
  headers.set("Accept", "application/json");
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  if (config.token) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const details = await readErrorBody(response);
    const message = `Browser workspace request failed (${response.status})${details ? `: ${details}` : ""}`;
    throw createBrowserWorkspaceError(
      response.status === 404 ? "tab_not_found" : "command_failed",
      path,
      message,
      details || undefined,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export async function evaluateBrowserWorkspaceTab(
  request: EvaluateBrowserWorkspaceTabRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    throw createBrowserWorkspaceError(
      "desktop_only",
      "eval",
      "Eliza browser workspace eval is only available in the desktop app.",
    );
  }

  const evalBody: { script: string; partition?: string } = {
    script: request.script,
  };
  if (request.partition !== undefined) {
    evalBody.partition = request.partition;
  }

  const payload = await requestBrowserWorkspace<{ result: unknown }>(
    `/tabs/${encodeURIComponent(request.id)}/eval`,
    {
      method: "POST",
      body: JSON.stringify(evalBody),
    },
    env,
    request.timeoutMs,
  );
  return payload.result;
}

export async function snapshotBrowserWorkspaceTab(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ data: string }> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    throw createBrowserWorkspaceError(
      "desktop_only",
      "snapshot",
      "Eliza browser workspace snapshot is only available in the desktop app.",
    );
  }

  return await requestBrowserWorkspace<{ data: string }>(
    `/tabs/${encodeURIComponent(id)}/snapshot`,
    undefined,
    env,
  );
}

function desktopBrowserWorkspaceWaitScriptBranch(
  env: NodeJS.ProcessEnv,
): string {
  if (isBrowserWorkspaceUserScriptAllowed(env)) {
    return `
          if (command.script) {
            const fn = new Function("document", "window", "location", "return (" + command.script + ");");
            if (fn(activeDoc(), window, location)) {
              resolve({ ok: true, script: true });
              return;
            }
          }`;
  }
  return `
          if (command.script) {
            reject(new Error("Wait conditions with a script are disabled in the browser workspace."));
            return;
          }`;
}

/**
 * Page-side helpers shared by the command and utility scripts: the selected
 * frame's document, the element table inspect stamps into the page, a unique
 * selector builder and a CSS.escape fallback. The table lives on a
 * non-enumerable Symbol property of the page's window, so any navigation
 * discards it and a ref from before the navigation cannot resolve.
 */
const DESKTOP_PAGE_HELPERS = `
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const workspaceState = () =>
    window.__elizaBrowserWorkspaceState ||
    (window.__elizaBrowserWorkspaceState = {
      consoleEntries: [],
      currentFrame: null,
      dialog: null,
      highlightedSelector: null,
      mouse: { buttons: [], x: 0, y: 0 }
    });
  let activeDocumentCache = null;
  const activeDoc = () => {
    if (activeDocumentCache) return activeDocumentCache;
    const frameSelector = (window.__elizaBrowserWorkspaceState || {}).currentFrame;
    if (!frameSelector) return (activeDocumentCache = document);
    let frameDocument = null;
    try {
      const frame = document.querySelector(frameSelector);
      frameDocument = frame ? frame.contentDocument : null;
    } catch {}
    if (!frameDocument) {
      throw new Error("The selected frame is not accessible. Select the main frame (frame main) or another frame.");
    }
    return (activeDocumentCache = frameDocument);
  };
  const isTag = (element, ...tags) =>
    Boolean(element && typeof element.tagName === "string" && tags.includes(element.tagName));
  const isControl = (element) => isTag(element, "INPUT", "TEXTAREA", "SELECT");
  // Password and hidden inputs: results name them but never carry their value.
  const isPrivateControl = ${BROWSER_WORKSPACE_PRIVATE_CONTROL_SCRIPT};
  const exposedValue = (element) => (isPrivateControl(element) ? null : element.value);
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    const text = String(value);
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 0) out += "\\uFFFD";
      else if (
        (code >= 1 && code <= 31) ||
        code === 127 ||
        (i === 0 && code >= 48 && code <= 57) ||
        (i === 1 && code >= 48 && code <= 57 && text.charCodeAt(0) === 45)
      ) out += "\\\\" + code.toString(16) + " ";
      else if (i === 0 && code === 45 && text.length === 1) out += "\\\\-";
      else if (
        code >= 128 || code === 45 || code === 95 ||
        (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      ) out += text[i];
      else out += "\\\\" + text[i];
    }
    return out;
  };
  const uniqueSelectorFor = (element) => {
    if (!element || !element.tagName) return "";
    const rootNode = element.getRootNode ? element.getRootNode() : null;
    const root = rootNode && typeof rootNode.querySelectorAll === "function" ? rootNode : element.ownerDocument;
    const unique = (selector) => {
      try {
        return root.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };
    const tag = element.tagName.toLowerCase();
    const idSelector = (target) => (target.id ? "#" + cssEscape(target.id) : null);
    const testId = element.getAttribute("data-testid");
    const name = element.getAttribute("name");
    const candidates = [
      idSelector(element),
      testId ? "[data-testid=" + JSON.stringify(testId) + "]" : null,
      name ? tag + "[name=" + JSON.stringify(name) + "]" : null
    ];
    for (const candidate of candidates) {
      if (candidate && unique(candidate)) return candidate;
    }
    const nthOfType = (target) => {
      let index = 1;
      for (let sibling = target.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === target.tagName) index += 1;
      }
      return target.tagName.toLowerCase() + ":nth-of-type(" + index + ")";
    };
    let selector = nthOfType(element);
    for (let ancestor = element.parentElement; ancestor && !unique(selector); ancestor = ancestor.parentElement) {
      const anchor = idSelector(ancestor);
      if (anchor && unique(anchor)) return anchor + " > " + selector;
      selector = nthOfType(ancestor) + " > " + selector;
    }
    return selector;
  };
  // A path such as "label:nth-of-type(2) > input" would read back as a
  // semantic label: lookup, so it is marked as plain CSS, as on the web backend.
  const SEMANTIC_PREFIX = /^(alt|css|data-testid|testid|label|placeholder|role|text|title)\\s*[:=]/i;
  const selectorFor = (element) => {
    const selector = uniqueSelectorFor(element);
    return SEMANTIC_PREFIX.test(selector) ? "css:" + selector : selector;
  };
  const stripCssPrefix = (selector) => String(selector || "").replace(/^css\\s*[:=]\\s*/i, "");
  const REF_TABLE_KEY = Symbol.for("elizaos.browserWorkspace.elementRefs");
  const stampElementRefs = (elements) => {
    const tableId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    Object.defineProperty(window, REF_TABLE_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: { id: tableId, elements: elements.map((element) => new WeakRef(element)) }
    });
    return tableId;
  };
  const resolveElementRef = (ref) => {
    const table = window[REF_TABLE_KEY];
    const entry = table && table.id === ref.tableId ? table.elements[ref.index] : null;
    const element = entry ? entry.deref() : null;
    if (!element || !element.isConnected) {
      throw new Error(
        "Unknown browser snapshot element ref @e" + (ref.index + 1) +
          ". Run snapshot or inspect again before reusing element refs."
      );
    }
    return element;
  };
  const queryOneWithin = (root, selector) => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  // NOTE: these scripts are built inside template literals. The whitespace
  // class in the split pattern needs a double backslash in this source so the
  // generated page script sees a single-backslash whitespace class.
  const walkSelectorChain = (start, segments) => {
    let current = start;
    for (let index = 0; current && index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) continue;
      if (typeof current.matches === "function" && current.matches(segment)) continue;
      if (/^(input|textarea|select)(?:\\[[^\\]]+\\])?$/i.test(segment) && isControl(current)) continue;
      current = queryOneWithin(current, segment);
    }
    return current;
  };
  const splitSelectorChain = (selector) =>
    String(selector || "")
      .split(/\\s*>>\\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
  // A ref may carry a suffix: "@e3 >> input" walks the chain from the element,
  // "@e3 span" queries inside it.
  const applyRefSuffix = (element, suffix) => {
    const rest = String(suffix || "").trim();
    if (!rest) return element;
    if (rest.startsWith(">>")) return walkSelectorChain(element, splitSelectorChain(rest.slice(2)));
    return queryOneWithin(element, ":scope " + rest);
  };
`;

export function createDesktopBrowserWorkspaceCommandScript(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    command.subaction === "upload" ||
    command.subaction === "realistic-upload"
  ) {
    throw new Error(BROWSER_WORKSPACE_UPLOAD_UNAVAILABLE);
  }
  const waitScriptBranch = desktopBrowserWorkspaceWaitScriptBranch(env);
  return `
(() => {
  const command = ${JSON.stringify(command)};
  ${DESKTOP_PAGE_HELPERS}
  const SKIPPED_TEXT = "script, style, noscript, template";
  const BLOCK_SELECTOR =
    "address, article, aside, blockquote, body, caption, dd, details, dialog, div, dl, dt, fieldset, figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, li, main, nav, ol, option, p, pre, section, summary, table, tbody, td, tfoot, th, thead, tr, ul";
  // Page prose only, as the web backend reads it: no script, style or noscript text.
  const readText = (element) => {
    if (!element || element.closest(SKIPPED_TEXT)) return "";
    const walker = element.ownerDocument.createTreeWalker(element, 5);
    const parts = [];
    let previousBlock;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest(SKIPPED_TEXT)) continue;
      if (node.nodeName === "BR" || node.nodeName === "HR") {
        parts.push(" ");
      } else if (node.nodeType === 3) {
        const block = node.parentElement ? node.parentElement.closest(BLOCK_SELECTOR) : null;
        if (block !== previousBlock) parts.push(" ");
        previousBlock = block;
        parts.push(node.nodeValue || "");
      }
    }
    return normalize(parts.join(""));
  };
  const truncated = false;
  const serialize = (element) => {
    const value = isControl(element) && !isPrivateControl(element) ? element.value : null;
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: isControl(element) ? normalize(value) : readText(element),
      type: element.getAttribute("type"),
      name: element.getAttribute("name"),
      href: element.getAttribute("href"),
      value: typeof value === "string" ? value : null,
    };
  };
  const searchTexts = (element) => {
    const labelText = element.id
      ? Array.from(activeDoc().querySelectorAll("label[for=" + JSON.stringify(element.id) + "]"))
          .map((label) => label.textContent)
          .join(" ")
      : "";
    return [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      element.getAttribute("alt"),
      element.getAttribute("data-testid"),
      labelText,
      element.value,
    ]
      .map((value) => normalize(value))
      .filter(Boolean);
  };
  const textMatches = (candidate, wanted, exact = false) => {
    const left = normalize(candidate).toLowerCase();
    const right = normalize(wanted).toLowerCase();
    if (!left || !right) return false;
    return exact ? left === right : left.includes(right);
  };
  const innerTextMatches = (matches) =>
    matches.filter(
      (element) =>
        element.matches("a, button, input, textarea, select, option, [role='button']") ||
        !matches.some((other) => other !== element && element.contains(other))
    );
  const isVisible = (element) => {
    if (!element) return false;
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = element.style || {};
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const nativeRole = (element) => {
    const explicit = element.getAttribute("role")?.trim()?.toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.getAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "textarea") return "textbox";
    if (tag === "form") return "form";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    return null;
  };
  const findAllByText = (wanted, exact = false) => {
    const needle = normalize(wanted).toLowerCase();
    if (!needle) return [];
    const elements = Array.from(activeDoc().querySelectorAll(
      "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
    ));
    return innerTextMatches(elements.filter((element) => {
      const haystacks = [
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.getAttribute("title"),
        element.getAttribute("name"),
        element.value,
      ]
        .map((value) => normalize(value))
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      return haystacks.some((value) => exact ? value === needle : value.includes(needle));
    }));
  };
  const findAllByLabel = (wanted, exact = false) => {
    const found = [];
    const labels = Array.from(activeDoc().querySelectorAll("label"));
    for (const label of labels) {
      if (!textMatches(label.textContent, wanted, exact)) continue;
      const forId = label.getAttribute("for");
      if (forId) {
        const explicit = activeDoc().getElementById(forId);
        if (explicit) {
          found.push(explicit);
          continue;
        }
      }
      const nested = label.querySelector("input, textarea, select, button");
      if (nested) found.push(nested);
    }
    return [...new Set(found)];
  };
  const findAllByRole = (role, name, exact = false) => {
    const found = [];
    const candidates = Array.from(
      activeDoc().querySelectorAll(
        "a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]"
      )
    );
    for (const candidate of candidates) {
      if (nativeRole(candidate) !== role.trim().toLowerCase()) continue;
      if (!name) {
        found.push(candidate);
        continue;
      }
      if (searchTexts(candidate).some((value) => textMatches(value, name, exact))) {
        found.push(candidate);
      }
    }
    return found;
  };
  const trimQuoted = (value) => {
    const trimmed = String(value || "").trim();
    const hasTextMatch = trimmed.match(/^has-text\\((?:"([^"]*)"|'([^']*)')\\)$/i);
    if (hasTextMatch?.[1] || hasTextMatch?.[2]) {
      return (hasTextMatch[1] || hasTextMatch[2] || "").trim();
    }
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  };
  const normalizeSelectorSyntax = (selector) => {
    let normalized = String(selector || "").trim();
    normalized = normalized.replace(
      /^role\\s*[:=]\\s*([a-z0-9_-]+)\\s+name\\s*[:=]\\s*(.+)$/i,
      "role=$1[name=$2]"
    );
    normalized = normalized.replace(
      /^((?:label|text|placeholder|alt|title|testid|data-testid)\\s*[:=]\\s*(?:has-text\\((?:"[^"]*"|'[^']*')\\)|"[^"]+"|'[^']+'|[^>]+?))\\s+((?:input|textarea|select)[\\s\\S]*)$/i,
      "$1 >> $2"
    );
    return normalized;
  };
  const parseSemanticSelector = (selector) => {
    const trimmed = normalizeSelectorSyntax(selector);
    const match = trimmed.match(/^([a-z-]+)\\s*[:=]\\s*(.+)$/i);
    if (!match) return null;
    const kind = match[1]?.trim()?.toLowerCase();
    const rawValue = match[2]?.trim() || "";
    if (!kind || !rawValue) return null;
    switch (kind) {
      case "alt":
        return { findBy: "alt", text: trimQuoted(rawValue) };
      case "css":
        return { selector: trimQuoted(rawValue) };
      case "data-testid":
      case "testid":
        return { findBy: "testid", text: trimQuoted(rawValue) };
      case "label":
        return { findBy: "label", text: trimQuoted(rawValue) };
      case "placeholder":
        return { findBy: "placeholder", text: trimQuoted(rawValue) };
      case "role": {
        const roleMatch = rawValue.match(
          /^([a-z0-9_-]+)(?:\\s*\\[\\s*name\\s*[:=]\\s*(.+?)\\s*\\])?$/i
        );
        if (!roleMatch?.[1]) return null;
        return {
          findBy: "role",
          name: roleMatch[2] ? trimQuoted(roleMatch[2]) : undefined,
          role: roleMatch[1].trim().toLowerCase(),
        };
      }
      case "text":
        return { findBy: "text", text: trimQuoted(rawValue) };
      case "title":
        return { findBy: "title", text: trimQuoted(rawValue) };
      default:
        return null;
    }
  };
  // css: names a plain selector, so it clears any findBy the caller sent.
  const mergeSelectorCommand = (selector) => {
    const parsed = parseSemanticSelector(selector);
    if (!parsed) return null;
    return { ...command, ...parsed, findBy: parsed.findBy, selector: parsed.selector };
  };
  const queryOne = (selector) => queryOneWithin(activeDoc(), selector);
  const queryAll = (selector) => {
    try {
      return Array.from(activeDoc().querySelectorAll(selector));
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const findAllSemantic = (targetCommand = command) => {
    switch (targetCommand.findBy) {
      case "alt":
        return targetCommand.text
          ? Array.from(activeDoc().querySelectorAll("[alt]")).filter((element) =>
              textMatches(element.getAttribute("alt"), targetCommand.text, targetCommand.exact)
            )
          : [];
      case "first":
        return targetCommand.selector
          ? [queryOne(targetCommand.selector)].filter(Boolean)
          : [];
      case "label":
        return targetCommand.text
          ? findAllByLabel(targetCommand.text, targetCommand.exact)
          : [];
      case "last":
        return targetCommand.selector
          ? [queryAll(targetCommand.selector).at(-1)].filter(Boolean)
          : [];
      case "nth":
        return targetCommand.selector && Number.isInteger(targetCommand.index)
          ? [queryAll(targetCommand.selector).at(targetCommand.index)].filter(Boolean)
          : [];
      case "placeholder":
        return targetCommand.text
          ? Array.from(activeDoc().querySelectorAll("[placeholder]")).filter((element) =>
              textMatches(element.getAttribute("placeholder"), targetCommand.text, targetCommand.exact)
            )
          : [];
      case "role":
        return targetCommand.role
          ? findAllByRole(targetCommand.role, targetCommand.name, targetCommand.exact)
          : [];
      case "testid":
        return targetCommand.text
          ? Array.from(activeDoc().querySelectorAll("[data-testid]")).filter(
              (element) => element.getAttribute("data-testid") === targetCommand.text
            )
          : [];
      case "text":
        return targetCommand.text ? findAllByText(targetCommand.text, targetCommand.exact) : [];
      case "title":
        return Array.from(activeDoc().querySelectorAll("[title]")).filter((element) =>
          textMatches(element.getAttribute("title"), targetCommand.text, targetCommand.exact)
        );
      default:
        return [];
    }
  };
  const findSemantic = (targetCommand = command) => findAllSemantic(targetCommand)[0] || null;
  const queryTarget = (selector) => {
    const semantic = mergeSelectorCommand(selector);
    if (semantic && semantic.findBy) return findSemantic(semantic);
    return queryOne(semantic ? semantic.selector : selector);
  };
  const findTarget = () => {
    if (command.elementRef) {
      return applyRefSuffix(resolveElementRef(command.elementRef), command.selector);
    }
    if (command.selector) {
      const selectorChain = splitSelectorChain(normalizeSelectorSyntax(command.selector));
      if (selectorChain.length > 1) {
        return walkSelectorChain(queryTarget(selectorChain[0]), selectorChain.slice(1));
      }
      return queryTarget(command.selector);
    }
    if (command.findBy) return findSemantic();
    if (command.text) return findAllByText(command.text, command.exact)[0] || null;
    return null;
  };
  const inspect = () => {
    const all = Array.from(
      activeDoc().querySelectorAll(
        "a, button, input, textarea, select, form, [role='button'], [data-testid]"
      )
    );
    const elements = all;
    const tableId = stampElementRefs(elements);
    return { elements: elements.map((element) => serialize(element)), tableId };
  };
  const snapshot = () => {
    const { elements, tableId } = inspect();
    const bodyText = readText(activeDoc().body);
    return { title: document.title, url: location.href, bodyText, elements, tableId, truncated };
  };
  // Set through the prototype's value setter: frameworks that track the last
  // value on the element itself (React) then see the change on input/change.
  const setNativeValue = (element, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  };
  const dispatchValueEvents = (element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setInputValue = (appendMode, target) => {
    const element = target || findTarget();
    if (!element) {
      throw new Error("Target element was not found.");
    }
    if (!isControl(element)) {
      throw new Error("Target element is not an input, textarea, or select.");
    }
    const nextValue = appendMode ? String(element.value ?? "") + String(command.value ?? "") : String(command.value ?? "");
    setNativeValue(element, nextValue);
    dispatchValueEvents(element);
    return { selector: selectorFor(element), value: exposedValue(element) };
  };
  const setChecked = (targetValue) => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    const type = isTag(element, "INPUT") ? (element.type || "").toLowerCase() : "";
    if (type !== "checkbox" && type !== "radio") {
      throw new Error("Target element is not a checkbox or radio input.");
    }
    element.checked = targetValue;
    dispatchValueEvents(element);
    return { checked: element.checked, selector: selectorFor(element) };
  };
  const setSelectValue = () => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    if (!isTag(element, "SELECT")) {
      throw new Error("Target element is not a select.");
    }
    const targetValue = command.value ?? "";
    const option = Array.from(element.options).find(
      (entry) =>
        entry.value === targetValue || textMatches(entry.textContent, targetValue, true)
    );
    if (!option) {
      throw new Error("Select option was not found.");
    }
    setNativeValue(element, option.value);
    option.selected = true;
    dispatchValueEvents(element);
    return { selector: selectorFor(element), value: element.value };
  };
  const focusElement = (element) => {
    if (!element) throw new Error("Target element was not found.");
    if (typeof element.focus === "function") {
      element.focus();
      // Match the web backend: typing after focus lands after existing text.
      if (isTag(element, "INPUT", "TEXTAREA")) {
        try {
          if (element.selectionStart !== null) {
            element.setSelectionRange(element.value.length, element.value.length);
          }
        } catch {}
      }
    }
    return {
      focused: element.ownerDocument.activeElement === element,
      selector: selectorFor(element),
    };
  };
  const hoverElement = (element) => {
    if (!element) throw new Error("Target element was not found.");
    element.setAttribute("data-eliza-hover", "true");
    return { hovered: true, selector: selectorFor(element) };
  };
  const activateElement = (subaction, element) => {
    if (!element) throw new Error("Target element was not found.");
    if (subaction === "dblclick") {
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }
    if (typeof element.click === "function") {
      element.click();
    }
    return {
      clickCount: subaction === "dblclick" ? 2 : 1,
      element: serialize(element),
      url: location.href,
    };
  };
  const ensureTabKit = () => {
    const kit = window.__elizaTabKit;
    if (!kit) {
      throw new Error(
        "browser tab kit not installed (BROWSER_TAB_PRELOAD_SCRIPT missing)",
      );
    }
    return kit;
  };
  const runRealisticSubaction = (subaction) => {
    const kit = ensureTabKit();
    const cursorDuration = Number(command.cursorDurationMs) || 220;
    if (subaction === "cursor-hide") {
      kit.cursor.hide();
      return { hidden: true };
    }
    if (subaction === "cursor-move") {
      const x = Number(command.x);
      const y = Number(command.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("cursor-move requires x and y");
      }
      kit.cursor.show();
      return Promise.resolve(
        kit.cursor.moveTo({ x: x, y: y }, { durationMs: cursorDuration }),
      ).then(() => ({ x: x, y: y }));
    }
    if (subaction === "realistic-press") {
      const target = findTarget() || activeDoc().activeElement || activeDoc().body;
      const key = command.key || "Enter";
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: key,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: key,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      return { key: key, selector: selectorFor(target), url: location.href };
    }
    const element = findTarget();
    if (!element) {
      throw new Error("Target element was not found.");
    }
    kit.cursor.show();
    if (subaction === "realistic-click") {
      kit.cursor.highlight(element);
      return Promise.resolve(
        kit.dispatchPointerSequence(element, { button: 0 }),
      ).then(() => ({
        element: serialize(element),
        url: location.href,
      }));
    }
    if (subaction === "realistic-fill" || subaction === "realistic-type") {
      const value = command.value ?? command.text ?? "";
      const replace = subaction === "realistic-fill" || command.replace === true;
      const perCharDelayMs = Number(command.perCharDelayMs);
      kit.cursor.highlight(element);
      return Promise.resolve(
        kit
          .dispatchPointerSequence(element, { button: 0 })
          .then(() =>
            kit.typeRealistic(element, value, {
              replace: replace,
              perCharDelayMs: Number.isFinite(perCharDelayMs)
                ? perCharDelayMs
                : undefined,
            }),
          ),
      ).then(() => ({
        element: serialize(element),
        value: exposedValue(element),
      }));
    }
    throw new Error("Unsupported realistic subaction: " + subaction);
  };
  const keyboardTarget = () => findTarget() || activeDoc().activeElement || activeDoc().body;
  const keyboardWrite = (appendMode) => {
    const target = keyboardTarget();
    if (!isControl(target)) {
      throw new Error("Keyboard text input requires an input, textarea, or select target.");
    }
    if (isTag(target, "SELECT")) return setInputValue(appendMode, target);
    // Both keyboard commands insert at the caret or replace the selected text,
    // matching the web backend.
    if (target.readOnly || target.disabled) {
      return { selector: selectorFor(target), value: exposedValue(target) };
    }
    let start = null;
    try {
      start = target.selectionStart;
    } catch {}
    if (start === null) return setInputValue(true, target);
    target.setRangeText(command.value ?? "", start, target.selectionEnd ?? start, "end");
    dispatchValueEvents(target);
    return { selector: selectorFor(target), value: exposedValue(target) };
  };
  const keyPhase = (phase) => {
    const target = keyboardTarget();
    const key = command.key || "Enter";
    target.dispatchEvent(new KeyboardEvent(phase, { key, bubbles: true }));
    return { key, phase, selector: selectorFor(target) };
  };
  // Text controls whose Enter submits the form (implicit submission).
  const IMPLICIT_SUBMIT_TYPES = [
    "text", "search", "url", "tel", "email", "password", "date", "month",
    "week", "time", "datetime-local", "number"
  ];
  const blocksImplicitSubmission = (element) =>
    isTag(element, "INPUT") && IMPLICIT_SUBMIT_TYPES.includes(String(element.type).toLowerCase());
  // Synthetic key events are untrusted, so the browser runs no default action
  // for them. Run the one that matters (Enter submits or activates) here and
  // say when the key did nothing.
  const press = () => {
    const doc = activeDoc();
    const target = findTarget() || doc.activeElement || doc.body;
    const key = command.key || "Enter";
    const proceed = target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    if (!proceed) {
      return { key, effect: "prevented", message: "The page handled the key and cancelled its default action." };
    }
    if (key === "Enter" && !target.disabled) {
      const type = String(target.type || "").toLowerCase();
      if (isTag(target, "BUTTON") || (isTag(target, "INPUT") && ["submit", "image", "button", "reset"].includes(type))) {
        target.click();
        return { key, effect: "clicked", selector: selectorFor(target) };
      }
      const form = blocksImplicitSubmission(target) ? target.form : null;
      if (form) {
        const controls = Array.from(form.elements);
        const defaultButton = controls.find(
          (control) =>
            (isTag(control, "BUTTON") && control.type === "submit") ||
            (isTag(control, "INPUT") && ["submit", "image"].includes(control.type))
        );
        if (
          defaultButton
            ? !defaultButton.disabled
            : controls.filter(blocksImplicitSubmission).length <= 1
        ) {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit(defaultButton || undefined);
          } else {
            form.submit();
          }
          return { key, effect: "submitted", selector: selectorFor(form) };
        }
      }
    }
    return { key, effect: "none", message: "The key had no default action here; page handlers may still have run." };
  };
  const scroll = () => {
    const target = findTarget();
    const direction = command.direction || "down";
    const pixels = Math.max(1, Math.abs(Number(command.pixels) || 240));
    const axis = direction === "left" || direction === "right" ? "x" : "y";
    const delta = direction === "up" || direction === "left" ? -pixels : pixels;
    if (target && target.nodeType === 1) {
      if (axis === "y") {
        target.scrollTop = (target.scrollTop || 0) + delta;
        return { axis, selector: selectorFor(target), value: target.scrollTop };
      }
      target.scrollLeft = (target.scrollLeft || 0) + delta;
      return { axis, selector: selectorFor(target), value: target.scrollLeft };
    }
    const view = activeDoc().defaultView || window;
    if (axis === "y") {
      view.scrollBy(0, delta);
      return { axis, selector: null, value: view.scrollY };
    }
    view.scrollBy(delta, 0);
    return { axis, selector: null, value: view.scrollX };
  };
  const getResult = () => {
    if (command.getMode === "title") return document.title;
    if (command.getMode === "url") return location.href;
    if (command.getMode === "count") {
      if (command.elementRef) return findTarget() ? 1 : 0;
      if (!command.selector) throw new Error("count requires selector");
      const semantic = mergeSelectorCommand(command.selector);
      if (semantic && semantic.findBy) return findAllSemantic(semantic).length;
      const cssSelector =
        semantic && semantic.selector ? semantic.selector : command.selector;
      return queryAll(cssSelector).length;
    }
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    switch (command.getMode) {
      case "attr":
        if (!command.attribute) throw new Error("attr lookups require attribute");
        return element.getAttribute(command.attribute);
      case "box":
        return element.getBoundingClientRect();
      case "checked":
        return isTag(element, "INPUT")
          ? Boolean(element.checked)
          : isTag(element, "OPTION")
            ? Boolean(element.selected)
            : false;
      case "enabled":
        return "disabled" in element ? !Boolean(element.disabled) : true;
      case "html":
        return element.innerHTML;
      case "styles": {
        const computed = (element.ownerDocument.defaultView || window).getComputedStyle(element);
        return {
          display: computed.display || null,
          visibility: computed.visibility || null,
          opacity: computed.opacity || null,
        };
      }
      case "text":
        return readText(element);
      case "value":
        if (isPrivateControl(element)) return null;
        return element.value ?? element.getAttribute("value");
      case "visible":
        return isVisible(element);
      default:
        return readText(element);
    }
  };
  const waitForCondition = () =>
    new Promise((resolve, reject) => {
      if (
        !command.selector &&
        !command.elementRef &&
        !command.findBy &&
        !command.text &&
        !command.url &&
        !command.script &&
        Number.isFinite(Number(command.timeoutMs))
      ) {
        const waitedMs = Math.max(0, Number(command.timeoutMs) || 0);
        setTimeout(() => resolve({ ok: true, waitedMs }), waitedMs);
        return;
      }
      const deadline = Date.now() + (Number(command.timeoutMs) || 4000);
      const check = () => {
        try {
          if (command.selector || command.elementRef) {
            let found = null;
            try {
              found = findTarget();
            } catch (error) {
              // A ref whose element went away counts as hidden, not as an error.
              if (!command.elementRef || command.state !== "hidden") throw error;
            }
            const visible =
              command.state === "hidden"
                ? !found || !isVisible(found)
                : found && isVisible(found);
            if (visible) {
              resolve({ ok: true, selector: command.selector, state: command.state || "visible" });
              return;
            }
          }
          if (command.findBy) {
            const found = findSemantic();
            if (command.state === "hidden" ? !found : found) {
              resolve({ findBy: command.findBy, ok: true });
              return;
            }
          }
          if (command.text && normalize(activeDoc().body?.textContent).includes(command.text)) {
            resolve({ ok: true, text: command.text });
            return;
          }
          if (command.url && location.href.includes(command.url)) {
            resolve({ ok: true, url: location.href });
            return;
          }
          ${waitScriptBranch}
          if (Date.now() >= deadline) {
            reject(new Error("Timed out waiting for browser workspace condition."));
            return;
          }
          setTimeout(check, 100);
        } catch (error) {
          reject(error);
        }
      };
      check();
    });

  const run = () => {
    switch (command.subaction) {
      case "inspect": {
        const { elements, tableId } = inspect();
        return { title: document.title, url: location.href, elements, tableId, truncated };
      }
      case "snapshot":
        return snapshot();
      case "get":
        return { value: getResult() };
      case "find": {
        const element = findTarget();
        if (!element) throw new Error("Target element was not found.");
        switch (command.action) {
          case "check":
            return setChecked(true);
          case "click":
            return activateElement("click", element);
          case "fill":
            return setInputValue(false, element);
          case "focus":
            return focusElement(element);
          case "hover":
            return hoverElement(element);
          case "text":
          case undefined:
            return { element: serialize(element), value: readText(element) };
          case "type":
            return setInputValue(true, element);
          case "uncheck":
            return setChecked(false);
          default:
            throw new Error("Unsupported find action.");
        }
      }
      case "click":
        return activateElement("click", findTarget());
      case "dblclick":
        return activateElement("dblclick", findTarget());
      case "check":
        return setChecked(true);
      case "fill":
        return setInputValue(false);
      case "focus":
        return focusElement(findTarget());
      case "hover":
        return hoverElement(findTarget());
      case "keyboardinserttext":
        return keyboardWrite(false);
      case "keyboardtype":
        return keyboardWrite(true);
      case "keydown":
        return keyPhase("keydown");
      case "keyup":
        return keyPhase("keyup");
      case "type":
        return setInputValue(true);
      case "press":
        return press();
      case "realistic-click":
      case "realistic-fill":
      case "realistic-type":
      case "realistic-press":
      case "cursor-move":
      case "cursor-hide":
        return runRealisticSubaction(command.subaction);
      case "scroll":
        return scroll();
      case "scrollinto": {
        const element = findTarget();
        if (!element) throw new Error("Target element was not found.");
        if (typeof element.scrollIntoView === "function") {
          element.scrollIntoView();
        }
        return { scrolled: true, selector: selectorFor(element) };
      }
      case "select":
        return setSelectValue();
      case "uncheck":
        return setChecked(false);
      case "wait":
        return waitForCondition();
      // These finish after this script returns; the host reads the tab's new
      // URL and title once the navigation lands.
      case "back":
        history.back();
        return { navigating: true };
      case "forward":
        history.forward();
        return { navigating: true };
      case "reload":
        location.reload();
        return { navigating: true };
      default:
        throw new Error("Unsupported desktop browser subaction: " + command.subaction);
    }
  };
  // The document URL travels with every result so the host can drop element
  // refs taken on an earlier document.
  const finish = (value) => ({ ${DESKTOP_RESULT_MARKER}: true, value, documentUrl: location.href });
  const result = run();
  return result && typeof result.then === "function" ? result.then(finish) : finish(result);
})()
`.trim();
}

/** Marks a command script result envelope (value plus the document URL). */
const DESKTOP_RESULT_MARKER = "__elizaWorkspaceResult";

function unwrapDesktopBrowserWorkspaceResult(result: unknown): {
  value: unknown;
  documentUrl: string | null;
} {
  if (
    result &&
    typeof result === "object" &&
    (result as Record<string, unknown>)[DESKTOP_RESULT_MARKER] === true
  ) {
    const envelope = result as { value?: unknown; documentUrl?: unknown };
    return {
      value: envelope.value,
      documentUrl:
        typeof envelope.documentUrl === "string" ? envelope.documentUrl : null,
    };
  }
  return { value: result, documentUrl: null };
}

/**
 * The page reports a stale ref as a plain script error; give it the same
 * machine-readable code a stale web ref has.
 */
async function withDesktopElementRefErrors<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ref = message.match(/Unknown browser snapshot element ref (@e\d+)/i);
    if (ref?.[1]) {
      throw createBrowserWorkspaceUnknownElementRefError(ref[1]);
    }
    throw error;
  }
}

export function createDesktopBrowserWorkspaceUtilityScript(
  command: BrowserWorkspaceCommand,
  options: { clipboardText?: string } = {},
): string {
  const parsedDeltaX =
    typeof command.deltaX === "number" && Number.isFinite(command.deltaX)
      ? command.deltaX
      : undefined;
  const parsedDeltaY =
    typeof command.deltaY === "number" && Number.isFinite(command.deltaY)
      ? command.deltaY
      : undefined;
  const parsedPixels =
    typeof command.pixels === "number" && Number.isFinite(command.pixels)
      ? command.pixels
      : undefined;
  if (command.deltaX !== undefined && parsedDeltaX === undefined) {
    throw createBrowserWorkspaceError(
      "command_failed",
      "mouse",
      "Eliza browser workspace mouse deltaX must be a finite number.",
    );
  }
  if (command.deltaY !== undefined && parsedDeltaY === undefined) {
    throw createBrowserWorkspaceError(
      "command_failed",
      "mouse",
      "Eliza browser workspace mouse deltaY must be a finite number.",
    );
  }
  if (command.pixels !== undefined && parsedPixels === undefined) {
    throw createBrowserWorkspaceError(
      "command_failed",
      "mouse",
      "Eliza browser workspace mouse pixels must be a finite number.",
    );
  }
  const mouseDeltaX = parsedDeltaX ?? 0;
  const mouseDeltaY = parsedDeltaY ?? parsedPixels ?? 240;
  return `
(() => {
  const command = ${JSON.stringify(command)};
  const clipboardText = ${JSON.stringify(options.clipboardText ?? "")};
  ${DESKTOP_PAGE_HELPERS}
  const queryOne = (selector) => queryOneWithin(activeDoc(), stripCssPrefix(selector));
  const findByText = (needle) => {
    const wanted = normalize(needle).toLowerCase();
    if (!wanted) return null;
    const candidates = Array.from(
      activeDoc().querySelectorAll(
        "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
      )
    );
    const matches = candidates.filter((element) => {
      const haystacks = [
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("placeholder"),
        element.getAttribute("title"),
        element.getAttribute("name"),
        element.value
      ]
        .map((value) => normalize(value).toLowerCase())
        .filter(Boolean);
      return haystacks.some((value) => value.includes(wanted));
    });
    // Keep the link or button inside a matching wrapper (see the command script).
    return (
      matches.find(
        (element) =>
          element.matches("a, button, input, textarea, select, option, [role='button']") ||
          !matches.some((other) => other !== element && element.contains(other))
      ) || null
    );
  };
  const resolveTarget = () => {
    if (command.elementRef) {
      return applyRefSuffix(resolveElementRef(command.elementRef), command.selector);
    }
    if (command.selector) return queryOne(command.selector);
    if (command.text) return findByText(command.text);
    return activeDoc().activeElement || activeDoc().body;
  };
  switch (command.subaction) {
    case "clipboard": {
      // Clipboard text is held by the host; the page only reads or receives it.
      const action = command.clipboardAction || "read";
      if (action === "copy") {
        const target = resolveTarget();
        if (isPrivateControl(target)) throw new Error("Password and hidden fields cannot be copied.");
        return target && typeof target.value === "string"
          ? String(target.value || "")
          : normalize((target && target.textContent) || (activeDoc().body && activeDoc().body.textContent));
      }
      const target = resolveTarget();
      if (target && typeof target.value === "string") {
        target.value = String(target.value || "") + clipboardText;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { selector: selectorFor(target), value: exposedValue(target) };
      }
      return clipboardText;
    }
    case "mouse": {
      const state = workspaceState();
      const action = command.mouseAction || "move";
      if (action === "move") {
        state.mouse.x = typeof command.x === "number" ? command.x : state.mouse.x;
        state.mouse.y = typeof command.y === "number" ? command.y : state.mouse.y;
        return state.mouse;
      }
      if (action === "down") {
        const button = command.button || "left";
        state.mouse.buttons = Array.from(new Set([...(state.mouse.buttons || []), button]));
        return state.mouse;
      }
      if (action === "up") {
        const button = command.button || "left";
        state.mouse.buttons = (state.mouse.buttons || []).filter((entry) => entry !== button);
        return state.mouse;
      }
      window.scrollBy(${JSON.stringify(mouseDeltaX)}, ${JSON.stringify(mouseDeltaY)});
      const axis = Math.abs(${JSON.stringify(mouseDeltaY)}) >= Math.abs(${JSON.stringify(mouseDeltaX)}) ? "y" : "x";
      return { axis, value: axis === "y" ? window.scrollY : window.scrollX };
    }
    case "drag": {
      const source = resolveTarget();
      const target = command.valueElementRef
        ? resolveElementRef(command.valueElementRef)
        : command.value
          ? queryOne(command.value)
          : null;
      if (!source || !target) throw new Error("Eliza browser workspace drag requires source selector and target selector in value.");
      source.setAttribute("data-eliza-dragging", "true");
      target.setAttribute("data-eliza-drop-target", "true");
      return { source: selectorFor(source), target: selectorFor(target) };
    }
    case "cookies": {
      const action = command.cookieAction || "get";
      if (action === "clear") {
        const current = document.cookie || "";
        current.split(/;\\s*/).forEach((entry) => {
          const name = entry.split("=")[0];
          if (name) document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        });
        return { cleared: true };
      }
      if (action === "set") {
        const name = command.name || command.entryKey;
        if (!name) throw new Error("Eliza browser workspace cookies set requires name.");
        document.cookie = name + "=" + (command.value || "") + "; path=/";
      }
      const cookieString = document.cookie || "";
      return Object.fromEntries(
        cookieString
          .split(/;\\s*/)
          .filter(Boolean)
          .map((entry) => {
            const [name, ...rest] = entry.split("=");
            return [name, rest.join("=")];
          })
      );
    }
    case "storage": {
      const storage = command.storageArea === "session" ? sessionStorage : localStorage;
      const action = command.storageAction || "get";
      if (action === "clear") {
        storage.clear();
        return { cleared: true };
      }
      if (action === "set") {
        const key = command.entryKey || command.name;
        if (!key) throw new Error("Eliza browser workspace storage set requires entryKey.");
        storage.setItem(key, command.value || "");
      }
      if (command.entryKey || command.name) {
        return storage.getItem(command.entryKey || command.name);
      }
      const out = {};
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) out[key] = storage.getItem(key) || "";
      }
      return out;
    }
    case "dialog": {
      // The page's alert/confirm/prompt are replaced only once the agent asks
      // about dialogs; from then on confirm() answers false and prompt() null.
      const state = workspaceState();
      if (!state.dialogWrapped) {
        window.alert = (message) => {
          state.dialog = { defaultValue: null, message: String(message ?? ""), open: true, type: "alert" };
        };
        window.confirm = (message) => {
          state.dialog = { defaultValue: null, message: String(message ?? ""), open: true, type: "confirm" };
          return false;
        };
        window.prompt = (message, defaultValue) => {
          state.dialog = {
            defaultValue: defaultValue ?? null,
            message: String(message ?? ""),
            open: true,
            type: "prompt"
          };
          return null;
        };
        state.dialogWrapped = true;
      }
      const action = command.dialogAction || "status";
      if (action === "status") return state.dialog;
      if (state.dialog) state.dialog.open = false;
      const result =
        action === "accept"
          ? { accepted: true, dialog: state.dialog, promptText: command.promptText || command.value || null }
          : { accepted: false, dialog: state.dialog };
      state.dialog = null;
      return result;
    }
    case "console": {
      // Console capture starts at the first console command and keeps the
      // page's own console output.
      const state = workspaceState();
      if (!state.consoleWrapped) {
        for (const level of ["log", "info", "warn", "error"]) {
          const original = console[level];
          console[level] = (...args) => {
            state.consoleEntries.push({
              level,
              message: args.map((value) => normalize(value)).join(" "),
              timestamp: new Date().toISOString()
            });
            return typeof original === "function" ? original.apply(console, args) : undefined;
          };
        }
        state.consoleWrapped = true;
      }
      if (command.consoleAction === "clear") state.consoleEntries = [];
      return state.consoleEntries;
    }
    case "highlight": {
      const state = workspaceState();
      const target = resolveTarget();
      if (!target) throw new Error("Target element was not found.");
      target.setAttribute("data-eliza-highlight", "true");
      state.highlightedSelector = selectorFor(target);
      return { selector: state.highlightedSelector };
    }
    case "frame": {
      const state = workspaceState();
      if ((command.frameAction || "select") === "main") {
        state.currentFrame = null;
        return { frame: null };
      }
      const frame = command.elementRef
        ? resolveElementRef(command.elementRef)
        : command.selector
          ? queryOneWithin(document, stripCssPrefix(command.selector))
          : null;
      if (!frame || frame.tagName !== "IFRAME") throw new Error("Eliza browser workspace frame select requires an iframe selector.");
      state.currentFrame = uniqueSelectorFor(frame);
      return { frame: state.currentFrame };
    }
    default:
      throw new Error("Unsupported desktop browser workspace utility subaction: " + command.subaction);
  }
})()
`.trim();
}

/**
 * Desktop settings and network shaping would only patch page globals that the
 * next navigation discards (and would leave credentials readable by the
 * page), so they are refused until the host can apply them.
 */
function assertDesktopBrowserWorkspaceUtilitySupported(
  command: BrowserWorkspaceCommand,
): void {
  const unsupported =
    command.subaction === "set"
      ? `set ${command.setAction ?? "viewport"}`
      : command.subaction === "network"
        ? `network ${command.networkAction ?? "requests"}`
        : command.subaction === "errors"
          ? "errors"
          : null;
  if (unsupported) {
    throw new BrowserDispatchFailure(
      "UNSUPPORTED",
      `Eliza browser workspace ${unsupported} is not available on the desktop browser yet.`,
    );
  }
}

export async function executeDesktopBrowserWorkspaceUtilityCommand(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceCommandResult> {
  if (
    command.subaction === "upload" ||
    command.subaction === "realistic-upload"
  ) {
    throw new Error(BROWSER_WORKSPACE_UPLOAD_UNAVAILABLE);
  }
  assertDesktopBrowserWorkspaceUtilitySupported(command);
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  command = resolveBrowserWorkspaceCommandElementRefs(command, "desktop", id);
  if (command.subaction === "cookies" || command.subaction === "storage") {
    await assertDesktopBrowserWorkspaceCanAccessProfileSecrets(
      id,
      env,
      command.subaction,
    );
  }
  const clipboardAction = command.clipboardAction ?? "read";
  if (
    command.subaction === "clipboard" &&
    (clipboardAction === "read" || clipboardAction === "write")
  ) {
    if (clipboardAction === "write") {
      setBrowserWorkspaceClipboardText(command.value ?? command.text ?? "");
    }
    return {
      mode: "desktop",
      subaction: command.subaction,
      value: browserWorkspaceClipboardText,
    };
  }
  const startedAt = Date.now();
  const result = await withDesktopElementRefErrors(
    evaluateBrowserWorkspaceTab(
      {
        id,
        script: createDesktopBrowserWorkspaceUtilityScript(
          { ...command, id },
          { clipboardText: browserWorkspaceClipboardText },
        ),
        timeoutMs: resolveBrowserCommandTimeoutMs(command),
      },
      env,
    ),
  );
  if (command.subaction === "clipboard" && clipboardAction === "copy") {
    setBrowserWorkspaceClipboardText(typeof result === "string" ? result : "");
  }
  const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
  appendBrowserWorkspaceTraceEntry(runtime, {
    subaction: command.subaction,
    type: "utility",
  });
  appendBrowserWorkspaceProfilerEntry(runtime, {
    durationMs: Date.now() - startedAt,
    subaction: command.subaction,
    type: "utility",
  });
  return {
    mode: "desktop",
    subaction: command.subaction,
    value: result,
  };
}

export async function getDesktopBrowserWorkspaceSnapshotRecord(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceSnapshotRecord> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const activeDocument = (() => {
    const state = window.__elizaBrowserWorkspaceState || {};
    if (!state.currentFrame) return document;
    try {
      const frame = document.querySelector(state.currentFrame);
      return frame && frame.contentDocument ? frame.contentDocument : document;
    } catch {
      return document;
    }
  })();
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const isPrivateControl = ${BROWSER_WORKSPACE_PRIVATE_CONTROL_SCRIPT};
  const controlText = Array.from(activeDocument.querySelectorAll("input, textarea, select, option:checked"))
    .map((element) => {
      const name = element.getAttribute("name") || element.getAttribute("id") || element.tagName.toLowerCase();
      if (isPrivateControl(element)) return name;
      const value =
        element.tagName === "SELECT"
          ? element.value
          : typeof element.value === "string"
            ? element.value
            : element.textContent || "";
      return name + ":" + normalize(value);
    })
    .filter(Boolean)
    .join(" ");
  return {
    bodyText: normalize((activeDocument.body?.textContent || "") + " " + controlText),
    title: normalize(document.title),
    url: location.href
  };
})()
      `.trim(),
    },
    env,
  );
  return result as BrowserWorkspaceSnapshotRecord;
}

export async function getDesktopBrowserWorkspaceSessionState(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  await assertDesktopBrowserWorkspaceCanAccessProfileSecrets(id, env, "state");
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const readStorage = (storage) => {
    const out = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) out[key] = storage.getItem(key) || "";
    }
    return out;
  };
  const cookies = Object.fromEntries(
    String(document.cookie || "")
      .split(/;\\s*/)
      .filter(Boolean)
      .map((entry) => {
        const [name, ...rest] = entry.split("=");
        return [name, rest.join("=")];
      })
  );
  return {
    cookies,
    localStorage: readStorage(localStorage),
    sessionStorage: readStorage(sessionStorage),
    url: location.href
  };
})()
      `.trim(),
    },
    env,
  );
  return {
    clipboard: browserWorkspaceClipboardText,
    ...(result as Record<string, unknown>),
  };
}

export async function loadDesktopBrowserWorkspaceSessionState(
  command: BrowserWorkspaceCommand,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  await assertDesktopBrowserWorkspaceCanAccessProfileSecrets(id, env, "state");
  await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const payload = ${JSON.stringify({
    cookies: payload.cookies,
    localStorage: payload.localStorage,
    sessionStorage: payload.sessionStorage,
  })};
  localStorage.clear();
  for (const [key, value] of Object.entries(payload.localStorage || {})) {
    localStorage.setItem(key, String(value ?? ""));
  }
  sessionStorage.clear();
  for (const [key, value] of Object.entries(payload.sessionStorage || {})) {
    sessionStorage.setItem(key, String(value ?? ""));
  }
  for (const [key, value] of Object.entries(payload.cookies || {})) {
    document.cookie = key + "=" + String(value ?? "") + "; path=/";
  }
  return { loaded: true };
})()
      `.trim(),
    },
    env,
  );
  if (typeof payload.clipboard === "string") {
    setBrowserWorkspaceClipboardText(payload.clipboard);
  }
}

export async function executeDesktopBrowserWorkspaceDomCommand(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceCommandResult> {
  if (
    command.subaction === "upload" ||
    command.subaction === "realistic-upload"
  ) {
    throw new Error(BROWSER_WORKSPACE_UPLOAD_UNAVAILABLE);
  }
  assertBrowserWorkspaceUserScriptAllowed(
    command.script,
    "wait",
    "desktop",
    env,
  );
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const startedAt = Date.now();
  command = resolveBrowserWorkspaceCommandElementRefs(command, "desktop", id);
  const envelope = await withDesktopElementRefErrors(
    evaluateBrowserWorkspaceTab(
      {
        id,
        script: createDesktopBrowserWorkspaceCommandScript(
          {
            ...command,
            id,
          },
          env,
        ),
        // The page script can run as long as the host's eval budget (30s by
        // default) or the command's own wait; the 12s bridge default would
        // abort a wait or a long typed fill that is still running.
        timeoutMs: resolveBrowserCommandTimeoutMs(command),
      },
      env,
    ),
  );
  const { value: result, documentUrl } =
    unwrapDesktopBrowserWorkspaceResult(envelope);

  if (command.subaction === "inspect" || command.subaction === "snapshot") {
    const value =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as {
            bodyText?: string;
            elements?: BrowserWorkspaceDomElementSummary[];
            tableId?: string;
          })
        : null;
    const tableId = typeof value?.tableId === "string" ? value.tableId : null;
    if (value) delete value.tableId;
    const elements = tableId
      ? registerBrowserWorkspaceElementRefs(
          "desktop",
          id,
          Array.isArray(value?.elements) ? value.elements : [],
          { tableId, url: documentUrl },
        )
      : registerBrowserWorkspaceElementRefs("desktop", id, []);
    return {
      mode: "desktop",
      subaction: command.subaction,
      elements,
      value: result,
    };
  }

  if (documentUrl) {
    noteBrowserWorkspaceDocumentUrl("desktop", id, documentUrl);
  }
  const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
  appendBrowserWorkspaceTraceEntry(runtime, {
    subaction: command.subaction,
    type: "dom",
  });
  appendBrowserWorkspaceProfilerEntry(runtime, {
    durationMs: Date.now() - startedAt,
    subaction: command.subaction,
    type: "dom",
  });
  return {
    mode: "desktop",
    subaction: command.subaction,
    value:
      result && typeof result === "object" && !Array.isArray(result)
        ? ((result as { value?: unknown }).value ?? result)
        : result,
  };
}

// --- Desktop tab resolution ---

export function resolveBrowserWorkspaceCurrentTab(
  tabs: BrowserWorkspaceTab[],
): BrowserWorkspaceTab | null {
  if (tabs.length === 0) {
    return null;
  }

  return (
    tabs.find((tab) => tab.visible) ??
    [...tabs].sort((left, right) => {
      const leftTime = left.lastFocusedAt ?? left.updatedAt ?? "";
      const rightTime = right.lastFocusedAt ?? right.updatedAt ?? "";
      return (
        rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id)
      );
    })[0] ??
    null
  );
}

export async function resolveDesktopBrowserWorkspaceTargetTabId(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (command.id?.trim()) {
    return command.id.trim();
  }

  // This function is only called on desktop-bridge paths where the
  // Electrobun HTTP bridge is configured. Calling `listBrowserWorkspaceTabs`
  // from `browser-workspace.ts` here would create a compile-time circular
  // dependency (browser-workspace → desktop → browser-workspace); the web
  // fallback in that function is also not reachable from these call sites.
  // Query the bridge directly and avoid the circular detour.
  const payload = await requestBrowserWorkspace<{
    tabs?: BrowserWorkspaceTab[];
  }>("/tabs", undefined, env);
  const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
  const current = resolveBrowserWorkspaceCurrentTab(tabs);
  if (!current) {
    throw createBrowserWorkspaceCommandTargetError(command.subaction);
  }
  return current.id;
}
