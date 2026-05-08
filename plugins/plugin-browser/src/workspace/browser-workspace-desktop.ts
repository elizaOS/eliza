import {
  createBrowserWorkspaceCommandTargetError,
  DEFAULT_TIMEOUT_MS,
  normalizeEnvValue,
  resolveBrowserWorkspaceCommandElementRefs,
} from "./browser-workspace-helpers.js";
import {
  appendBrowserWorkspaceProfilerEntry,
  appendBrowserWorkspaceTraceEntry,
  getBrowserWorkspaceRuntimeState,
  registerBrowserWorkspaceElementRefs,
} from "./browser-workspace-state.js";
import type {
  BrowserWorkspaceBridgeConfig,
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceDomElementSummary,
  BrowserWorkspaceSnapshotRecord,
  BrowserWorkspaceTab,
} from "./browser-workspace-types.js";

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 240);
  } catch {
    return "";
  }
}

export function resolveBrowserWorkspaceBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserWorkspaceBridgeConfig | null {
  const baseUrl =
    normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_URL) ??
    normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_URL);
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/{1,1024}$/, ""),
    token:
      normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_TOKEN) ??
      normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_TOKEN),
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
): Promise<T> {
  const config = resolveBrowserWorkspaceBridgeConfig(env);
  if (!config) {
    throw new Error(getBrowserWorkspaceUnavailableMessage());
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
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(
      `Browser workspace request failed (${response.status})${details ? `: ${details}` : ""}`,
    );
  }

  return (await response.json()) as T;
}

export async function evaluateBrowserWorkspaceTab(
  request: { id: string; script: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    throw new Error(
      "Eliza browser workspace eval is only available in the desktop app.",
    );
  }

  const payload = await requestBrowserWorkspace<{ result: unknown }>(
    `/tabs/${encodeURIComponent(request.id)}/eval`,
    {
      method: "POST",
      body: JSON.stringify({ script: request.script }),
    },
    env,
  );
  return payload.result;
}

export async function snapshotBrowserWorkspaceTab(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ data: string }> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    throw new Error(
      "Eliza browser workspace snapshot is only available in the desktop app.",
    );
  }

  return await requestBrowserWorkspace<{ data: string }>(
    `/tabs/${encodeURIComponent(id)}/snapshot`,
    undefined,
    env,
  );
}

export function createDesktopBrowserWorkspaceCommandScript(
  command: BrowserWorkspaceCommand,
): string {
  return `
(() => {
  const command = ${JSON.stringify(command)};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const textMatches = (candidate, wanted, exact = false) => {
    const left = normalize(candidate).toLowerCase();
    const right = normalize(wanted).toLowerCase();
    if (!left || !right) return false;
    return exact ? left === right : left.includes(right);
  };
  const selectorFor = (element) => {
    if (!element) return "";
    if (element.id) return "#" + element.id.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    const testId = element.getAttribute?.("data-testid");
    if (testId) return \`[data-testid="\${testId}"]\`;
    const name = element.getAttribute?.("name");
    if (name) return \`\${element.tagName.toLowerCase()}[name="\${name}"]\`;
    const type = element.getAttribute?.("type");
    if (type) return \`\${element.tagName.toLowerCase()}[type="\${type}"]\`;
    let index = 1;
    let previous = element.previousElementSibling;
    while (previous) {
      if (previous.tagName === element.tagName) index += 1;
      previous = previous.previousElementSibling;
    }
    return \`\${element.tagName.toLowerCase()}:nth-of-type(\${index})\`;
  };
  const serialize = (element) => {
    const value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : null;
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: normalize(value ?? element.textContent),
      type: element.getAttribute?.("type"),
      name: element.getAttribute?.("name"),
      href: element.getAttribute?.("href"),
      value: typeof value === "string" ? value : null,
    };
  };
  const searchTexts = (element) => {
    const labelText = element.id
      ? Array.from(document.querySelectorAll('label[for="' + element.id + '"]'))
          .map((label) => label.textContent)
          .join(" ")
      : "";
    return [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("title"),
      element.getAttribute?.("name"),
      element.getAttribute?.("alt"),
      element.getAttribute?.("data-testid"),
      labelText,
      element.value,
    ]
      .map((value) => normalize(value))
      .filter(Boolean);
  };
  const isVisible = (element) => {
    if (!element) return false;
    if (element.hasAttribute?.("hidden") || element.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
    const style = element.style || {};
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const nativeRole = (element) => {
    const explicit = element.getAttribute?.("role")?.trim()?.toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.getAttribute?.("href")) return "link";
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
  const findByText = (wanted) => {
    const needle = normalize(wanted).toLowerCase();
    if (!needle) return null;
    const elements = Array.from(document.querySelectorAll(
      "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
    ));
    for (const element of elements) {
      const haystacks = [
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("placeholder"),
        element.getAttribute?.("title"),
        element.getAttribute?.("name"),
        element.value,
      ]
        .map((value) => normalize(value))
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      if (haystacks.some((value) => value.includes(needle))) {
        return element;
      }
    }
    return null;
  };
  const findByLabel = (wanted, exact = false) => {
    const labels = Array.from(document.querySelectorAll("label"));
    for (const label of labels) {
      if (!textMatches(label.textContent, wanted, exact)) continue;
      const forId = label.getAttribute("for");
      if (forId) {
        const explicit = document.getElementById(forId);
        if (explicit) return explicit;
      }
      const nested = label.querySelector("input, textarea, select, button");
      if (nested) return nested;
    }
    return null;
  };
  const findByRole = (role, name, exact = false) => {
    const candidates = Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]"
      )
    );
    for (const candidate of candidates) {
      if (nativeRole(candidate) !== role.trim().toLowerCase()) continue;
      if (!name) return candidate;
      if (searchTexts(candidate).some((value) => textMatches(value, name, exact))) {
        return candidate;
      }
    }
    return null;
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
  const mergeSelectorCommand = (selector) => {
    const parsed = parseSemanticSelector(selector);
    if (!parsed) return null;
    return { ...command, ...parsed, selector: parsed.selector };
  };
  const queryOne = (selector) => {
    try {
      return document.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const queryAll = (selector) => {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const findSemantic = (targetCommand = command) => {
    switch (targetCommand.findBy) {
      case "alt":
        return Array.from(document.querySelectorAll("[alt]")).find((element) =>
          textMatches(
            element.getAttribute("alt"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      case "first":
        return targetCommand.selector ? queryOne(targetCommand.selector) : null;
      case "label":
        return targetCommand.text
          ? findByLabel(targetCommand.text, targetCommand.exact)
          : null;
      case "last":
        return targetCommand.selector
          ? queryAll(targetCommand.selector).at(-1) || null
          : null;
      case "nth":
        return targetCommand.selector && Number.isInteger(targetCommand.index)
          ? queryAll(targetCommand.selector).at(targetCommand.index) || null
          : null;
      case "placeholder":
        return Array.from(document.querySelectorAll("[placeholder]")).find((element) =>
          textMatches(
            element.getAttribute("placeholder"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      case "role":
        return targetCommand.role
          ? findByRole(
              targetCommand.role,
              targetCommand.name,
              targetCommand.exact
            )
          : null;
      case "testid":
        return targetCommand.text
          ? document.querySelector('[data-testid="' + targetCommand.text + '"]')
          : null;
      case "text":
        return targetCommand.text ? findByText(targetCommand.text) : null;
      case "title":
        return Array.from(document.querySelectorAll("[title]")).find((element) =>
          textMatches(
            element.getAttribute("title"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      default:
        return null;
    }
  };
  const findTarget = () => {
    if (command.selector) {
      const selectorChain = normalizeSelectorSyntax(command.selector)
        .split(/s*>>s*/)
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (selectorChain.length > 1) {
        let current = queryTarget(selectorChain[0]);
        for (let index = 1; current && index < selectorChain.length; index += 1) {
          const segment = selectorChain[index];
          if (!segment) continue;
          if (typeof current.matches === "function" && current.matches(segment)) {
            continue;
          }
          if (
            /^(input|textarea|select)(?:[[^]]+])?$/i.test(segment) &&
            (current.tagName === "INPUT" ||
              current.tagName === "TEXTAREA" ||
              current.tagName === "SELECT")
          ) {
            continue;
          }
          current = queryOneWithin(current, segment);
        }
        return current;
      }
      return queryTarget(command.selector);
    }
    if (command.findBy) return findSemantic();
    if (command.text) return findByText(command.text);
    return null;
  };
  const queryOneWithin = (root, selector) => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const queryTarget = (selector) => {
    const semantic = mergeSelectorCommand(selector);
    if (semantic) return findSemantic(semantic);
    return queryOne(selector);
  };
  const inspect = () =>
    Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, form, [role='button'], [data-testid]"
      )
    )
      .slice(0, 40)
      .map((element) => serialize(element));
  const snapshot = () => ({
    title: document.title,
    url: location.href,
    bodyText: normalize(document.body?.textContent).slice(0, 800),
    elements: inspect(),
  });
  const setInputValue = (appendMode, target) => {
    const element = target || findTarget();
    if (!element) {
      throw new Error("Target element was not found.");
    }
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
    ) {
      throw new Error("Target element is not an input, textarea, or select.");
    }
    const nextValue = appendMode ? \`\${element.value ?? ""}\${command.value ?? ""}\` : (command.value ?? "");
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selector: selectorFor(element), value: element.value };
  };
  const setChecked = (targetValue) => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Target element is not a checkbox or radio input.");
    }
    const type = (element.type || "").toLowerCase();
    if (type !== "checkbox" && type !== "radio") {
      throw new Error("Target element is not a checkbox or radio input.");
    }
    element.checked = targetValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { checked: element.checked, selector: selectorFor(element) };
  };
  const setSelectValue = () => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    if (!(element instanceof HTMLSelectElement)) {
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
    element.value = option.value;
    option.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selector: selectorFor(element), value: element.value };
  };
  const focusElement = (element) => {
    if (!element) throw new Error("Target element was not found.");
    if (typeof element.focus === "function") {
      element.focus();
    }
    return {
      focused: document.activeElement === element,
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
      const target = findTarget() || document.activeElement || document.body;
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
        value: element.value,
      }));
    }
    if (subaction === "realistic-upload") {
      const url = (command.files && command.files[0]) || command.url || command.value;
      if (!url) {
        throw new Error("realistic-upload requires files[0] or url");
      }
      if (element.tagName !== "INPUT" || element.type !== "file") {
        throw new Error("realistic-upload target must be input[type=file]");
      }
      kit.cursor.highlight(element);
      return Promise.resolve(kit.setFileInput(element, url, {})).then((info) => ({
        element: serialize(element),
        upload: info,
      }));
    }
    throw new Error("Unsupported realistic subaction: " + subaction);
  };
  const keyboardTarget = () => findTarget() || document.activeElement || document.body;
  const keyboardWrite = (appendMode) => {
    const target = keyboardTarget();
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
    ) {
      throw new Error("Keyboard text input requires an input, textarea, or select target.");
    }
    return setInputValue(appendMode, target);
  };
  const keyPhase = (phase) => {
    const target = keyboardTarget();
    const key = command.key || "Enter";
    target.dispatchEvent(new KeyboardEvent(phase, { key, bubbles: true }));
    return { key, phase, selector: selectorFor(target) };
  };
  const scrollTarget = () => findTarget();
  const scroll = () => {
    const target = scrollTarget();
    const direction = command.direction || "down";
    const pixels = Math.max(1, Math.abs(Number(command.pixels) || 240));
    const axis = direction === "left" || direction === "right" ? "x" : "y";
    const delta = direction === "up" || direction === "left" ? -pixels : pixels;
    if (target instanceof HTMLElement) {
      if (axis === "y") {
        target.scrollTop = (target.scrollTop || 0) + delta;
        return { axis, selector: selectorFor(target), value: target.scrollTop };
      }
      target.scrollLeft = (target.scrollLeft || 0) + delta;
      return { axis, selector: selectorFor(target), value: target.scrollLeft };
    }
    if (axis === "y") {
      window.scrollBy(0, delta);
      return { axis, selector: null, value: window.scrollY };
    }
    window.scrollBy(delta, 0);
    return { axis, selector: null, value: window.scrollX };
  };
  const getResult = () => {
    if (command.getMode === "title") return document.title;
    if (command.getMode === "url") return location.href;
    if (command.getMode === "count") {
      if (!command.selector) throw new Error("count requires selector");
      const semantic = mergeSelectorCommand(command.selector);
      return semantic ? Number(Boolean(findSemantic(semantic))) : queryAll(command.selector).length;
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
        return element instanceof HTMLInputElement
          ? Boolean(element.checked)
          : element instanceof HTMLOptionElement
            ? Boolean(element.selected)
            : false;
      case "enabled":
        return "disabled" in element ? !Boolean(element.disabled) : true;
      case "html":
        return element.innerHTML;
      case "styles": {
        const computed = getComputedStyle(element);
        return {
          display: computed.display || null,
          visibility: computed.visibility || null,
          opacity: computed.opacity || null,
        };
      }
      case "text":
        return normalize(element.textContent);
      case "value":
        return element.value ?? element.getAttribute?.("value");
      case "visible":
        return isVisible(element);
      default:
        return normalize(element.textContent);
    }
  };
  const waitForCondition = () =>
    new Promise((resolve, reject) => {
      if (
        !command.selector &&
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
          if (command.selector && findTarget()) {
            const found = findTarget();
            const visible =
              command.state === "visible"
                ? found && isVisible(found)
                : !found || !isVisible(found);
            if (visible) {
              resolve({ ok: true, selector: command.selector, state: command.state || "visible" });
              return;
            }
          }
          if (
            command.findBy &&
            (command.state === "visible") &&
            findSemantic()
          ) {
            resolve({ findBy: command.findBy, ok: true });
            return;
          }
          if (command.text && normalize(document.body?.textContent).includes(command.text)) {
            resolve({ ok: true, text: command.text });
            return;
          }
          if (command.url && location.href.includes(command.url)) {
            resolve({ ok: true, url: location.href });
            return;
          }
          if (command.script) {
            const fn = new Function("document", "window", "location", "return (" + command.script + ");");
            if (fn(document, window, location)) {
              resolve({ ok: true, script: true });
              return;
            }
          }
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

  switch (command.subaction) {
    case "inspect":
      return { title: document.title, url: location.href, elements: inspect() };
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
          return { element: serialize(element), value: normalize(element.textContent) };
        case "type":
          return setInputValue(true, element);
        case "uncheck":
          return setChecked(false);
        default:
          throw new Error("Unsupported find action.");
      }
    }
    case "click": {
      const element = findTarget();
      return activateElement("click", element);
    }
    case "dblclick": {
      const element = findTarget();
      return activateElement("dblclick", element);
    }
    case "check":
      return setChecked(true);
    case "fill":
      return setInputValue(false);
    case "focus": {
      const element = findTarget();
      return focusElement(element);
    }
    case "hover": {
      const element = findTarget();
      return hoverElement(element);
    }
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
    case "press": {
      const target = findTarget() ?? document.activeElement ?? document.body;
      const key = command.key || "Enter";
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      return { key, url: location.href };
    }
    case "realistic-click":
    case "realistic-fill":
    case "realistic-type":
    case "realistic-press":
    case "realistic-upload":
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
    case "back":
      history.back();
      return { url: location.href, title: document.title };
    case "forward":
      history.forward();
      return { url: location.href, title: document.title };
    case "reload":
      location.reload();
      return { url: location.href, title: document.title };
    default:
      throw new Error(\`Unsupported desktop browser subaction: \${command.subaction}\`);
  }
})()
`.trim();
}

export function createDesktopBrowserWorkspaceUtilityScript(
  command: BrowserWorkspaceCommand,
): string {
  return `
(() => {
  const command = ${JSON.stringify(command)};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const state =
    window.__elizaBrowserWorkspaceState ||
    (window.__elizaBrowserWorkspaceState = {
      clipboardText: "",
      consoleEntries: [],
      currentFrame: null,
      dialog: null,
      errors: [],
      highlightedSelector: null,
      mouse: { buttons: [], x: 0, y: 0 },
      networkHar: { active: false, entries: [], startedAt: null },
      networkNextRequestId: 1,
      networkRequests: [],
      networkRoutes: [],
      settings: {
        credentials: null,
        device: null,
        geo: null,
        headers: {},
        media: null,
        offline: false,
        viewport: null
      }
    });
  const patternMatches = (pattern, value) => {
    const trimmed = String(pattern ?? "").trim();
    if (!trimmed) return false;
    if (!trimmed.includes("*")) return String(value ?? "").includes(trimmed);
    let wildcard = "";
    for (let i = 0; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "*") {
        if (trimmed[i + 1] === "*") {
          wildcard += ".*";
          i += 1;
        } else {
          wildcard += ".*";
        }
      } else {
        wildcard += char.replace(/[|\\\\{}()[\\]^$+?.]/g, "\\\\$&");
      }
    }
    return new RegExp("^" + wildcard + "$", "i").test(String(value ?? ""));
  };
  const buildSelector = (element) => {
    if (!element || !element.tagName) return null;
    const testId = element.getAttribute && element.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId + '"]';
    const name = element.getAttribute && element.getAttribute("name");
    if (name) return element.tagName.toLowerCase() + '[name="' + name + '"]';
    const title = element.getAttribute && element.getAttribute("title");
    if (title) return element.tagName.toLowerCase() + '[title="' + title + '"]';
    return element.tagName.toLowerCase();
  };
  const activeDocument = (() => {
    if (!state.currentFrame) return document;
    try {
      const frame = document.querySelector(state.currentFrame);
      return frame && frame.contentDocument ? frame.contentDocument : document;
    } catch {
      return document;
    }
  })();
  const queryOne = (selector, root = activeDocument) => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const findByText = (needle) => {
    const wanted = normalize(needle).toLowerCase();
    if (!wanted) return null;
    const candidates = Array.from(
      activeDocument.querySelectorAll(
        "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
      )
    );
    return (
      candidates.find((element) => {
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
      }) || null
    );
  };
  const resolveTarget = () => {
    if (command.selector) return queryOne(command.selector);
    if (command.text) return findByText(command.text);
    return activeDocument.activeElement || activeDocument.body;
  };
  const recordRequest = (request) => {
    const entry = {
      ...request,
      id: "req_" + state.networkNextRequestId++,
      timestamp: new Date().toISOString()
    };
    state.networkRequests.push(entry);
    if (state.networkHar.active) state.networkHar.entries.push(entry);
    return entry;
  };
  if (!state.consoleWrapped) {
    for (const level of ["log", "info", "warn", "error"]) {
      console[level] = (...args) => {
        state.consoleEntries.push({
          level,
          message: args.map((value) => normalize(value)).join(" "),
          timestamp: new Date().toISOString()
        });
      };
    }
    state.consoleWrapped = true;
  }
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
  if (!state.fetchWrapped) {
    state.originalFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async (input, init = {}) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input?.url === "string"
              ? input.url
              : String(input);
      const url = new URL(inputUrl, location.href).toString();
      if (state.settings.offline) {
        recordRequest({
          matchedRoute: null,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: null,
          responseHeaders: {},
          status: 0,
          url
        });
        throw new Error("Browser workspace is offline.");
      }
      const route = [...state.networkRoutes].reverse().find((entry) => patternMatches(entry.pattern, url)) || null;
      if (route && route.abort) {
        recordRequest({
          matchedRoute: route.pattern,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: null,
          responseHeaders: route.headers || {},
          status: 0,
          url
        });
        throw new Error("Browser workspace network route aborted request: " + url);
      }
      if (route && (route.body !== null || route.status !== null || Object.keys(route.headers || {}).length > 0)) {
        const response = new Response(route.body || "", {
          headers: route.headers || {},
          status: route.status || 200
        });
        recordRequest({
          matchedRoute: route.pattern,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: route.body || "",
          responseHeaders: route.headers || {},
          status: route.status || 200,
          url
        });
        return response;
      }
      const headers = new Headers(init.headers || {});
      for (const [key, value] of Object.entries(state.settings.headers || {})) {
        if (!headers.has(key)) headers.set(key, value);
      }
      if (state.settings.credentials && state.settings.credentials.username && !headers.has("Authorization")) {
        headers.set(
          "Authorization",
          "Basic " + btoa(state.settings.credentials.username + ":" + state.settings.credentials.password)
        );
      }
      const response = await state.originalFetch(url, { ...init, headers });
      recordRequest({
        matchedRoute: null,
        method: String(init.method || "GET").toUpperCase(),
        resourceType: "fetch",
        responseBody: null,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        status: response.status,
        url: response.url || url
      });
      return response;
    };
    state.fetchWrapped = true;
  }
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => !state.settings.offline
  });
  switch (command.subaction) {
    case "clipboard": {
      const action = command.clipboardAction || "read";
      if (action === "read") return state.clipboardText;
      if (action === "write") {
        state.clipboardText = command.value || command.text || "";
        return state.clipboardText;
      }
      if (action === "copy") {
        const target = resolveTarget();
        state.clipboardText =
          target && typeof target.value === "string"
            ? String(target.value || "")
            : normalize(target?.textContent || activeDocument.body?.textContent);
        return state.clipboardText;
      }
      const target = resolveTarget();
      if (target && typeof target.value === "string") {
        target.value = String(target.value || "") + state.clipboardText;
        target.setAttribute("value", target.value);
        return { selector: buildSelector(target), value: target.value };
      }
      return state.clipboardText;
    }
    case "mouse": {
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
      window.scrollBy(command.deltaX || 0, command.deltaY || command.pixels || 240);
      return { axis: Math.abs(command.deltaY || 0) >= Math.abs(command.deltaX || 0) ? "y" : "x", value: window.scrollY };
    }
    case "drag": {
      const source = resolveTarget();
      const target = command.value ? queryOne(command.value) : null;
      if (!source || !target) throw new Error("Eliza browser workspace drag requires source selector and target selector in value.");
      source.setAttribute("data-eliza-dragging", "true");
      target.setAttribute("data-eliza-drop-target", "true");
      return { source: buildSelector(source), target: buildSelector(target) };
    }
    case "upload": {
      const target = resolveTarget();
      if (!target || target.tagName !== "INPUT") throw new Error("Eliza browser workspace upload requires a file input target.");
      const files = Array.isArray(command.files) ? command.files.map((entry) => String(entry).split(/[\\\\/]/).pop()) : [];
      target.setAttribute("data-eliza-uploaded-files", files.join(","));
      return { files, selector: buildSelector(target) };
    }
    case "set": {
      const action = command.setAction || "viewport";
      if (action === "viewport") {
        state.settings.viewport = { width: command.width || 1280, height: command.height || 720, scale: command.scale || 1 };
      } else if (action === "device") {
        state.settings.device = command.device || null;
      } else if (action === "geo") {
        state.settings.geo =
          typeof command.latitude === "number" && typeof command.longitude === "number"
            ? { latitude: command.latitude, longitude: command.longitude }
            : null;
      } else if (action === "offline") {
        state.settings.offline = Boolean(command.offline);
      } else if (action === "headers") {
        state.settings.headers = command.headers || {};
      } else if (action === "credentials") {
        state.settings.credentials =
          command.username || command.password
            ? { username: command.username || "", password: command.password || "" }
            : null;
      } else if (action === "media") {
        state.settings.media = command.media || null;
      }
      return state.settings;
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
    case "network": {
      const action = command.networkAction || "requests";
      if (action === "route") {
        if (!command.url) throw new Error("Eliza browser workspace network route requires url pattern.");
        state.networkRoutes.push({
          abort: Boolean(command.offline),
          body: command.responseBody ?? null,
          headers: command.responseHeaders || {},
          pattern: command.url,
          status: typeof command.responseStatus === "number" ? command.responseStatus : null
        });
        return state.networkRoutes;
      }
      if (action === "unroute") {
        state.networkRoutes = command.url
          ? state.networkRoutes.filter((entry) => entry.pattern !== command.url)
          : [];
        return state.networkRoutes;
      }
      if (action === "request") {
        return state.networkRequests.find((entry) => entry.id === command.requestId) || null;
      }
      if (action === "harstart") {
        state.networkHar = { active: true, entries: [], startedAt: new Date().toISOString() };
        return state.networkHar;
      }
      if (action === "harstop") {
        state.networkHar.active = false;
        return { log: { entries: state.networkHar.entries, startedAt: state.networkHar.startedAt } };
      }
      let requests = [...state.networkRequests];
      if (command.filter) requests = requests.filter((entry) => entry.url.includes(command.filter));
      if (command.method) requests = requests.filter((entry) => entry.method === String(command.method).toUpperCase());
      if (command.status) requests = requests.filter((entry) => String(entry.status || "") === String(command.status));
      return requests;
    }
    case "dialog": {
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
    case "console":
      if (command.consoleAction === "clear") state.consoleEntries = [];
      return state.consoleEntries;
    case "errors":
      if (command.consoleAction === "clear") state.errors = [];
      return state.errors;
    case "highlight": {
      const target = resolveTarget();
      if (!target) throw new Error("Target element was not found.");
      target.setAttribute("data-eliza-highlight", "true");
      state.highlightedSelector = buildSelector(target);
      return { selector: state.highlightedSelector };
    }
    case "frame": {
      if ((command.frameAction || "select") === "main") {
        state.currentFrame = null;
        return { frame: null };
      }
      const frame = command.selector ? document.querySelector(command.selector) : null;
      if (!frame || frame.tagName !== "IFRAME") throw new Error("Eliza browser workspace frame select requires an iframe selector.");
      state.currentFrame = buildSelector(frame);
      return { frame: state.currentFrame };
    }
    default:
      throw new Error("Unsupported desktop browser workspace utility subaction: " + command.subaction);
  }
})()
`.trim();
}

export async function executeDesktopBrowserWorkspaceUtilityCommand(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceCommandResult> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const startedAt = Date.now();
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: createDesktopBrowserWorkspaceUtilityScript({
        ...command,
        id,
      }),
    },
    env,
  );
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
  const controlText = Array.from(activeDocument.querySelectorAll("input, textarea, select, option:checked"))
    .map((element) => {
      const name = element.getAttribute("name") || element.getAttribute("id") || element.tagName.toLowerCase();
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
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const state = window.__elizaBrowserWorkspaceState || {};
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
    clipboard: state.clipboardText || "",
    cookies,
    localStorage: readStorage(localStorage),
    sessionStorage: readStorage(sessionStorage),
    settings: state.settings || {},
    url: location.href
  };
})()
      `.trim(),
    },
    env,
  );
  return result as Record<string, unknown>;
}

export async function loadDesktopBrowserWorkspaceSessionState(
  command: BrowserWorkspaceCommand,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const payload = ${JSON.stringify(payload)};
  const state =
    window.__elizaBrowserWorkspaceState ||
    (window.__elizaBrowserWorkspaceState = { settings: {} });
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
  state.clipboardText = typeof payload.clipboard === "string" ? payload.clipboard : "";
  state.settings = typeof payload.settings === "object" && payload.settings ? payload.settings : state.settings;
  return { loaded: true };
})()
      `.trim(),
    },
    env,
  );
}

export async function executeDesktopBrowserWorkspaceDomCommand(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceCommandResult> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const startedAt = Date.now();
  command = resolveBrowserWorkspaceCommandElementRefs(command, "desktop", id);
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: createDesktopBrowserWorkspaceCommandScript({
        ...command,
        id,
      }),
    },
    env,
  );

  if (command.subaction === "inspect" || command.subaction === "snapshot") {
    const value =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as {
            bodyText?: string;
            elements?: BrowserWorkspaceDomElementSummary[];
          })
        : null;
    const elements = registerBrowserWorkspaceElementRefs(
      "desktop",
      id,
      Array.isArray(value?.elements) ? value.elements : [],
    );
    return {
      mode: "desktop",
      subaction: command.subaction,
      elements,
      value: result,
    };
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
      const leftTime = left.lastFocusedAt ?? left.updatedAt;
      const rightTime = right.lastFocusedAt ?? right.updatedAt;
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
  // So hit the bridge directly and skip the detour.
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
