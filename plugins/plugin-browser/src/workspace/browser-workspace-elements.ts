/**
 * Element lookup, selector parsing, and DOM inspection helpers for browser workspace.
 */

import type { JSDOM } from "jsdom";
import {
  buildBrowserWorkspaceCssStringLiteral,
  isBrowserWorkspacePrivateControl,
  normalizeBrowserWorkspaceText,
  readBrowserWorkspaceElementText,
} from "./browser-workspace-helpers.js";
import { getJSDOMClass } from "./browser-workspace-jsdom.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceDomElementSummary,
  BrowserWorkspaceRuntimeState,
} from "./browser-workspace-types.js";

/**
 * CSS.escape as specified in CSSOM. JSDOM and Node have no global CSS object,
 * so ids such as `1-email` or `a:b` need this to form a valid selector.
 */
export function escapeBrowserWorkspaceCssIdentifier(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      result += "\uFFFD";
    } else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (index === 0 && code >= 0x30 && code <= 0x39) ||
      (index === 1 &&
        code >= 0x30 &&
        code <= 0x39 &&
        value.charCodeAt(0) === 0x2d)
    ) {
      result += `\\${code.toString(16)} `;
    } else if (index === 0 && code === 0x2d && value.length === 1) {
      result += `\\${value[index]}`;
    } else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      result += value[index];
    } else {
      result += `\\${value[index]}`;
    }
  }
  return result;
}

function browserWorkspaceSelectorRoot(element: Element): ParentNode {
  const root = element.getRootNode() as ParentNode;
  return typeof root.querySelectorAll === "function"
    ? root
    : element.ownerDocument;
}

function isUniqueBrowserWorkspaceSelector(
  root: ParentNode,
  selector: string,
): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function browserWorkspaceNthOfTypeSegment(element: Element): string {
  const tag = element.tagName.toLowerCase();
  let index = 1;
  for (
    let sibling = element.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.tagName === element.tagName) index += 1;
  }
  return `${tag}:nth-of-type(${index})`;
}

/**
 * A selector that matches exactly this element in its document: a unique id,
 * data-testid or name when there is one, else a tag:nth-of-type path that
 * grows one ancestor at a time (anchored on a unique ancestor id) until only
 * this element matches.
 */
export function buildBrowserWorkspaceElementSelector(element: Element): string {
  const root = browserWorkspaceSelectorRoot(element);
  const tag = element.tagName.toLowerCase();
  const idSelector = (target: Element) =>
    target.id ? `#${escapeBrowserWorkspaceCssIdentifier(target.id)}` : null;

  const testId = element.getAttribute("data-testid")?.trim();
  const name = element.getAttribute("name")?.trim();
  const candidates = [
    idSelector(element),
    testId
      ? `[data-testid=${buildBrowserWorkspaceCssStringLiteral(testId)}]`
      : null,
    name ? `${tag}[name=${buildBrowserWorkspaceCssStringLiteral(name)}]` : null,
  ];
  for (const candidate of candidates) {
    if (candidate && isUniqueBrowserWorkspaceSelector(root, candidate)) {
      return candidate;
    }
  }

  let selector = browserWorkspaceNthOfTypeSegment(element);
  for (
    let ancestor = element.parentElement;
    ancestor && !isUniqueBrowserWorkspaceSelector(root, selector);
    ancestor = ancestor.parentElement
  ) {
    const anchor = idSelector(ancestor);
    if (anchor && isUniqueBrowserWorkspaceSelector(root, anchor)) {
      return `${anchor} > ${selector}`;
    }
    selector = `${browserWorkspaceNthOfTypeSegment(ancestor)} > ${selector}`;
  }
  // `label:nth-of-type(2) > input` would read as a `label:` text lookup when
  // it is passed back as a selector; mark it as plain CSS.
  return parseBrowserWorkspaceSemanticSelector(selector)
    ? `css:${selector}`
    : selector;
}

export function createBrowserWorkspaceElementSummary(
  element: Element,
): BrowserWorkspaceDomElementSummary {
  const inputLike =
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT";

  const elementValue =
    inputLike && !isBrowserWorkspacePrivateControl(element)
      ? ((element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
          .value ?? null)
      : null;

  return {
    selector: buildBrowserWorkspaceElementSelector(element),
    tag: element.tagName.toLowerCase(),
    text: inputLike
      ? normalizeBrowserWorkspaceText(elementValue)
      : readBrowserWorkspaceElementText(element),
    type: element.getAttribute("type"),
    name: element.getAttribute("name"),
    href: element.getAttribute("href"),
    value: typeof elementValue === "string" ? elementValue : null,
  };
}

/** Inspect and snapshot list at most this many elements. */
export const BROWSER_WORKSPACE_INSPECT_ELEMENT_LIMIT = 40;

export function collectBrowserWorkspaceInspectElements(document: Document): {
  elements: Element[];
  summaries: BrowserWorkspaceDomElementSummary[];
  truncated: boolean;
} {
  const all = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, form, [role='button'], [data-testid]",
    ),
  );
  const elements = all.slice(0, BROWSER_WORKSPACE_INSPECT_ELEMENT_LIMIT);
  return {
    elements,
    summaries: elements.map((element) =>
      createBrowserWorkspaceElementSummary(element),
    ),
    truncated: all.length > elements.length,
  };
}

export function resolveBrowserWorkspaceIframeDocument(
  runtime: BrowserWorkspaceRuntimeState,
  frameElement: Element | null,
  baseUrl: string,
): Document | null {
  if (frameElement?.tagName !== "IFRAME") {
    return null;
  }

  const iframe = frameElement as HTMLIFrameElement;
  const srcdoc = iframe.getAttribute("srcdoc");
  if (srcdoc?.trim()) {
    const selector = buildBrowserWorkspaceElementSelector(frameElement);
    const cached = runtime.frameDoms.get(selector);
    if (cached) {
      return cached.window.document;
    }
    if (
      iframe.contentDocument &&
      normalizeBrowserWorkspaceText(iframe.contentDocument.body?.textContent)
        .length > 0
    ) {
      return iframe.contentDocument;
    }
    const parsed = new (getJSDOMClass())(srcdoc, {
      pretendToBeVisual: true,
      url: baseUrl,
    });
    runtime.frameDoms.set(selector, parsed);
    return parsed.window.document;
  }

  if (iframe.contentDocument) {
    return iframe.contentDocument;
  }

  return null;
}

export function resolveWebBrowserWorkspaceCommandDocument(
  tab: { id: string; url: string },
  dom: JSDOM,
  runtimeState: import("./browser-workspace-types.js").BrowserWorkspaceRuntimeState,
): { document: Document; frameSelector: string | null } {
  const state = runtimeState;
  const frameSelector = state.currentFrame?.trim() || null;
  if (!frameSelector) {
    return { document: dom.window.document, frameSelector: null };
  }

  const frameElement = resolveBrowserWorkspaceElement(
    dom.window.document,
    frameSelector,
  );
  const frameDocument = resolveBrowserWorkspaceIframeDocument(
    state,
    frameElement,
    tab.url,
  );
  if (!frameDocument) {
    return { document: dom.window.document, frameSelector: null };
  }

  return { document: frameDocument, frameSelector };
}

export function getBrowserWorkspaceElementSearchTexts(
  element: Element,
): string[] {
  const labelText =
    element.id && element.ownerDocument
      ? Array.from(
          element.ownerDocument.querySelectorAll(
            // The id is page-controlled. An unquoted interpolation of an id
            // that contains a quote (legal HTML, e.g. `phone"work`) makes the
            // selector invalid, and querySelectorAll then throws SyntaxError,
            // aborting the whole role/label search. Quote it with the same
            // helper this file uses for its other attribute selectors.
            `label[for=${buildBrowserWorkspaceCssStringLiteral(element.id)}]`,
          ),
        )
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
    (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
      .value,
  ]
    .map((value) => normalizeBrowserWorkspaceText(value))
    .filter(Boolean);
}

export function browserWorkspaceTextMatches(
  candidate: string,
  wanted: string,
  exact = false,
): boolean {
  const normalizedCandidate =
    normalizeBrowserWorkspaceText(candidate).toLowerCase();
  const normalizedWanted = normalizeBrowserWorkspaceText(wanted).toLowerCase();
  if (!normalizedCandidate || !normalizedWanted) {
    return false;
  }
  return exact
    ? normalizedCandidate === normalizedWanted
    : normalizedCandidate.includes(normalizedWanted);
}

export function isBrowserWorkspaceElementVisible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }

  const htmlElement = element as HTMLElement;
  const inlineDisplay = htmlElement.style?.display?.trim().toLowerCase();
  const inlineVisibility = htmlElement.style?.visibility?.trim().toLowerCase();
  if (inlineDisplay === "none" || inlineVisibility === "hidden") {
    return false;
  }

  return true;
}

export function findAllBrowserWorkspaceElementsByLabel(
  document: Document,
  labelText: string,
  exact = false,
): Element[] {
  const found: Element[] = [];
  const labels = Array.from(document.querySelectorAll("label"));
  for (const label of labels) {
    if (
      !browserWorkspaceTextMatches(label.textContent ?? "", labelText, exact)
    ) {
      continue;
    }

    const forId = label.getAttribute("for")?.trim();
    if (forId) {
      const explicit = document.getElementById(forId);
      if (explicit) {
        found.push(explicit);
        continue;
      }
    }

    const nested = label.querySelector("input, textarea, select, button");
    if (nested) {
      found.push(nested);
    }
  }
  return [...new Set(found)];
}

export function findBrowserWorkspaceElementByLabel(
  document: Document,
  labelText: string,
  exact = false,
): Element | null {
  return (
    findAllBrowserWorkspaceElementsByLabel(document, labelText, exact)[0] ??
    null
  );
}

export function getBrowserWorkspaceNativeRole(element: Element): string | null {
  const explicitRole = element.getAttribute("role")?.trim().toLowerCase();
  if (explicitRole) {
    return explicitRole;
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.getAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (tag === "textarea") return "textbox";
  if (tag === "form") return "form";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const input = element as HTMLInputElement;
    const type = (input.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset", "image"].includes(type)) {
      return "button";
    }
    return "textbox";
  }
  return null;
}

export function findAllBrowserWorkspaceElementsByRole(
  document: Document,
  role: string,
  name?: string,
  exact = false,
): Element[] {
  const wantedRole = role.trim().toLowerCase();
  if (!wantedRole) {
    return [];
  }

  const found: Element[] = [];
  const candidates = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]",
    ),
  );
  for (const candidate of candidates) {
    if (getBrowserWorkspaceNativeRole(candidate) !== wantedRole) {
      continue;
    }
    if (!name?.trim()) {
      found.push(candidate);
      continue;
    }
    const haystacks = getBrowserWorkspaceElementSearchTexts(candidate);
    if (
      haystacks.some((value) => browserWorkspaceTextMatches(value, name, exact))
    ) {
      found.push(candidate);
    }
  }
  return found;
}

export function findBrowserWorkspaceElementByRole(
  document: Document,
  role: string,
  name?: string,
  exact = false,
): Element | null {
  return (
    findAllBrowserWorkspaceElementsByRole(document, role, name, exact)[0] ??
    null
  );
}

export function trimBrowserWorkspaceQuotedValue(value: string): string {
  const trimmed = value.trim();
  const hasTextMatch = trimmed.match(/^has-text\((['"])([\s\S]*?)\1\)$/i);
  if (hasTextMatch?.[2]) {
    return hasTextMatch[2].trim();
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeBrowserWorkspaceSelectorSyntax(
  selector: string,
): string {
  let normalized = selector.trim();
  normalized = normalized.replace(
    /^role\s*[:=]\s*([a-z0-9_-]+)\s+name\s*[:=]\s*(.+)$/i,
    "role=$1[name=$2]",
  );
  normalized = normalized.replace(
    /^((?:label|text|placeholder|alt|title|testid|data-testid)\s*[:=]\s*(?:has-text\((['"])[\s\S]*?\2\)|"[^"]+"|'[^']+'|[^>]+?))\s+((?:input|textarea|select)[\s\S]*)$/i,
    "$1 >> $3",
  );
  return normalized;
}

export function parseBrowserWorkspaceSemanticSelector(
  selector: string,
): Pick<
  BrowserWorkspaceCommand,
  "findBy" | "name" | "role" | "selector" | "text"
> | null {
  const trimmed = normalizeBrowserWorkspaceSelectorSyntax(selector);
  const match = trimmed.match(/^([a-z-]+)\s*[:=]\s*(.+)$/i);
  if (!match) {
    return null;
  }

  const kind = match[1]?.trim().toLowerCase();
  const rawValue = match[2]?.trim() ?? "";
  if (!kind || !rawValue) {
    return null;
  }

  switch (kind) {
    case "alt":
      return { findBy: "alt", text: trimBrowserWorkspaceQuotedValue(rawValue) };
    case "css":
      return { selector: trimBrowserWorkspaceQuotedValue(rawValue) };
    case "data-testid":
    case "testid":
      return {
        findBy: "testid",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "label":
      return {
        findBy: "label",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "placeholder":
      return {
        findBy: "placeholder",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "role": {
      const roleMatch = rawValue.match(
        /^([a-z0-9_-]+)(?:\s*\[\s*name\s*[:=]\s*(.+?)\s*\])?$/i,
      );
      if (!roleMatch?.[1]) {
        return null;
      }
      return {
        findBy: "role",
        name: roleMatch[2]
          ? trimBrowserWorkspaceQuotedValue(roleMatch[2])
          : undefined,
        role: roleMatch[1].trim().toLowerCase(),
      };
    }
    case "text":
      return {
        findBy: "text",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "title":
      return {
        findBy: "title",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    default:
      return null;
  }
}

export function mergeBrowserWorkspaceSelectorCommand(
  command: BrowserWorkspaceCommand | undefined,
  selector: string,
): BrowserWorkspaceCommand | null {
  const parsed = parseBrowserWorkspaceSemanticSelector(selector);
  if (!parsed) {
    return null;
  }

  // `css:` names a plain selector: drop any findBy the caller sent so every
  // path queries it as CSS.
  return {
    ...command,
    ...parsed,
    findBy: parsed.findBy,
    selector: parsed.selector,
  } as BrowserWorkspaceCommand;
}

export function queryBrowserWorkspaceSelector(
  root: Document | Element,
  selector: string,
): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    throw new Error(`Invalid selector ${selector}`);
  }
}

export function queryAllBrowserWorkspaceSelector(
  root: Document | Element,
  selector: string,
): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    throw new Error(`Invalid selector ${selector}`);
  }
}

export function findAllBrowserWorkspaceElementsByText(
  document: Document,
  needle: string,
  exact = false,
): Element[] {
  const wanted = normalizeBrowserWorkspaceText(needle).toLowerCase();
  if (!wanted) {
    return [];
  }

  const candidates = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]",
    ),
  );

  const matches = candidates.filter((element) => {
    const haystacks = [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
        .value,
    ]
      .map((value) => normalizeBrowserWorkspaceText(value))
      .filter(Boolean)
      .map((value) => value.toLowerCase());

    return haystacks.some((value) =>
      exact ? value === wanted : value.includes(wanted),
    );
  });
  // A wrapper (a [data-testid] section, a heading, a label) contains the text
  // of the link or button inside it and comes first in document order. Keep the
  // inner control so a click by text reaches it, not the wrapper.
  return matches.filter(
    (element) =>
      element.matches(BROWSER_WORKSPACE_TEXT_CONTROL_SELECTOR) ||
      !matches.some((other) => other !== element && element.contains(other)),
  );
}

const BROWSER_WORKSPACE_TEXT_CONTROL_SELECTOR =
  "a, button, input, textarea, select, option, [role='button']";

export function findBrowserWorkspaceElementByText(
  document: Document,
  needle: string,
  exact = false,
): Element | null {
  return (
    findAllBrowserWorkspaceElementsByText(document, needle, exact)[0] ?? null
  );
}

export function resolveBrowserWorkspaceFindElement(
  document: Document,
  command: BrowserWorkspaceCommand,
): Element | null {
  return resolveBrowserWorkspaceFindElements(document, command)[0] ?? null;
}

/**
 * Every element a semantic find command matches, in document order, honoring
 * `exact`. `get`/`count` uses this so semantic selectors report the true match
 * count; {@link resolveBrowserWorkspaceFindElement} takes the first.
 */
export function resolveBrowserWorkspaceFindElements(
  document: Document,
  command: BrowserWorkspaceCommand,
): Element[] {
  switch (command.findBy) {
    case "alt":
      return command.text?.trim()
        ? Array.from(document.querySelectorAll("[alt]")).filter((element) =>
            browserWorkspaceTextMatches(
              element.getAttribute("alt") ?? "",
              command.text ?? "",
              command.exact,
            ),
          )
        : [];
    case "first": {
      const element = command.selector?.trim()
        ? queryBrowserWorkspaceSelector(document, command.selector)
        : null;
      return element ? [element] : [];
    }
    case "label":
      return command.text?.trim()
        ? findAllBrowserWorkspaceElementsByLabel(
            document,
            command.text,
            command.exact,
          )
        : [];
    case "last": {
      const element = command.selector?.trim()
        ? (queryAllBrowserWorkspaceSelector(document, command.selector).at(
            -1,
          ) ?? null)
        : null;
      return element ? [element] : [];
    }
    case "nth": {
      const element =
        command.selector?.trim() &&
        typeof command.index === "number" &&
        Number.isInteger(command.index)
          ? (queryAllBrowserWorkspaceSelector(document, command.selector).at(
              command.index,
            ) ?? null)
          : null;
      return element ? [element] : [];
    }
    case "placeholder":
      return command.text?.trim()
        ? Array.from(document.querySelectorAll("[placeholder]")).filter(
            (element) =>
              browserWorkspaceTextMatches(
                element.getAttribute("placeholder") ?? "",
                command.text ?? "",
                command.exact,
              ),
          )
        : [];
    case "role":
      return command.role?.trim()
        ? findAllBrowserWorkspaceElementsByRole(
            document,
            command.role,
            command.name,
            command.exact,
          )
        : [];
    case "testid":
      return command.text?.trim()
        ? Array.from(document.querySelectorAll("[data-testid]")).filter(
            (element) => element.getAttribute("data-testid") === command.text,
          )
        : [];
    case "text":
      return command.text?.trim()
        ? findAllBrowserWorkspaceElementsByText(
            document,
            command.text,
            command.exact,
          )
        : [];
    case "title":
      return Array.from(document.querySelectorAll("[title]")).filter(
        (element) =>
          browserWorkspaceTextMatches(
            element.getAttribute("title") ?? "",
            command.text ?? "",
            command.exact,
          ),
      );
    default:
      return [];
  }
}

export function resolveBrowserWorkspaceElement(
  document: Document,
  selector?: string,
  text?: string,
  command?: BrowserWorkspaceCommand,
): Element | null {
  const normalizedSelector = selector
    ? normalizeBrowserWorkspaceSelectorSyntax(selector)
    : undefined;
  if (normalizedSelector) {
    const selectorChain = normalizedSelector
      .split(/\s*>>\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (selectorChain.length > 1) {
      let current = resolveBrowserWorkspaceElement(
        document,
        selectorChain[0],
        undefined,
        command,
      );
      for (let index = 1; current && index < selectorChain.length; index += 1) {
        const segment = selectorChain[index];
        if (!segment) {
          continue;
        }
        if (
          typeof (current as Element).matches === "function" &&
          (current as Element).matches(segment)
        ) {
          continue;
        }
        if (
          /^(input|textarea|select)(?:\[[^\]]+\])?$/i.test(segment) &&
          (current.tagName === "INPUT" ||
            current.tagName === "TEXTAREA" ||
            current.tagName === "SELECT")
        ) {
          continue;
        }
        current = queryBrowserWorkspaceSelector(current, segment);
      }
      return current;
    }
    const semanticCommand = mergeBrowserWorkspaceSelectorCommand(
      command,
      normalizedSelector,
    );
    if (semanticCommand?.findBy) {
      return resolveBrowserWorkspaceFindElement(document, semanticCommand);
    }
    return queryBrowserWorkspaceSelector(
      document,
      semanticCommand?.selector ?? normalizedSelector,
    );
  }

  if (command?.findBy) {
    return resolveBrowserWorkspaceFindElement(document, command);
  }

  const normalizedText = text?.trim();
  if (normalizedText) {
    return findBrowserWorkspaceElementByText(
      document,
      normalizedText,
      command?.exact,
    );
  }

  return null;
}

export function getBrowserWorkspaceElementBox(element: Element): {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
  x: number;
  y: number;
} {
  const box =
    typeof (element as HTMLElement).getBoundingClientRect === "function"
      ? (element as HTMLElement).getBoundingClientRect()
      : {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
        };
  return {
    bottom: box.bottom,
    height: box.height,
    left: box.left,
    right: box.right,
    top: box.top,
    width: box.width,
    x: box.x,
    y: box.y,
  };
}

export function getBrowserWorkspaceElementValue(
  element: Element,
): string | boolean | null {
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    const control = element as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement;
    if (element.tagName === "INPUT") {
      const input = control as HTMLInputElement;
      const type = input.type.trim().toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return input.checked;
      }
    }
    return control.value;
  }
  return null;
}

export function getBrowserWorkspaceElementStyles(
  element: Element,
  window: Pick<Window, "getComputedStyle">,
): Record<string, string | null> {
  const computed = window.getComputedStyle(element);
  return {
    display: computed.display || null,
    visibility: computed.visibility || null,
    opacity: computed.opacity || null,
  };
}

export function findClosestBrowserWorkspaceForm(
  element: Element | null,
): HTMLFormElement | null {
  if (!element) {
    return null;
  }
  if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)) {
    return (
      element as
        | HTMLButtonElement
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
    ).form;
  }
  return (
    element.tagName === "FORM" ? element : element.closest("form")
  ) as HTMLFormElement | null;
}
