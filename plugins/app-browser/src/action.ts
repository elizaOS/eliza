import {
  type BrowserWorkspaceCommand,
  type BrowserWorkspaceCommandResult,
  type BrowserWorkspaceFindAction,
  type BrowserWorkspaceFindBy,
  type BrowserWorkspaceGetMode,
  type BrowserWorkspaceScrollDirection,
  type BrowserWorkspaceSubaction,
  type BrowserWorkspaceWaitState,
  executeBrowserWorkspaceCommand,
  getBrowserWorkspaceMode,
} from "@elizaos/agent";
import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  getTrajectoryContext,
  runWithTrajectoryContext,
} from "@elizaos/core";

type BrowserWorkspaceActionRequest = BrowserWorkspaceCommand;

const URL_RE = /https?:\/\/[^\s)]+/i;
const TAB_ID_RE = /\b(btab_\d+)\b/i;
const WRITE_SUBACTIONS: readonly BrowserWorkspaceSubaction[] = [
  "fill",
  "keyboardinserttext",
  "keyboardtype",
  "select",
  "type",
];
const EXPLICIT_SUBACTIONS: readonly BrowserWorkspaceSubaction[] = [
  "back",
  "batch",
  "check",
  "clipboard",
  "click",
  "close",
  "console",
  "cookies",
  "dblclick",
  "diff",
  "dialog",
  "drag",
  "errors",
  "eval",
  "fill",
  "find",
  "focus",
  "forward",
  "frame",
  "get",
  "highlight",
  "hide",
  "hover",
  "inspect",
  "keydown",
  "keyup",
  "keyboardinserttext",
  "keyboardtype",
  "list",
  "mouse",
  "navigate",
  "network",
  "open",
  "pdf",
  "press",
  "profiler",
  "reload",
  "scroll",
  "scrollinto",
  "screenshot",
  "select",
  "set",
  "show",
  "snapshot",
  "state",
  "storage",
  "tab",
  "trace",
  "type",
  "uncheck",
  "upload",
  "wait",
  "window",
];
const EXPLICIT_SUBACTION_SET = new Set<string>(EXPLICIT_SUBACTIONS);

function isWriteSubaction(
  subaction: BrowserWorkspaceSubaction | null | undefined,
): boolean {
  return Boolean(subaction && WRITE_SUBACTIONS.includes(subaction));
}

function getMessageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function normalizeSubaction(
  value: string | undefined,
): BrowserWorkspaceSubaction | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "goto":
      return "navigate";
    case "read":
      return "get";
    default:
      return EXPLICIT_SUBACTION_SET.has(normalized)
        ? (normalized as BrowserWorkspaceSubaction)
        : null;
  }
}

function normalizeGetMode(
  value: string | undefined,
): BrowserWorkspaceGetMode | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case "attr":
    case "box":
    case "checked":
    case "count":
    case "enabled":
    case "html":
    case "styles":
    case "text":
    case "title":
    case "url":
    case "value":
    case "visible":
      return value.trim().toLowerCase() as BrowserWorkspaceGetMode;
    default:
      return null;
  }
}

function normalizeFindBy(
  value: string | undefined,
): BrowserWorkspaceFindBy | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case "alt":
    case "first":
    case "label":
    case "last":
    case "nth":
    case "placeholder":
    case "role":
    case "testid":
    case "text":
    case "title":
      return value.trim().toLowerCase() as BrowserWorkspaceFindBy;
    default:
      return null;
  }
}

function normalizeFindAction(
  value: string | undefined,
): BrowserWorkspaceFindAction | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case "check":
    case "click":
    case "fill":
    case "focus":
    case "hover":
    case "text":
    case "type":
    case "uncheck":
      return value.trim().toLowerCase() as BrowserWorkspaceFindAction;
    default:
      return null;
  }
}

function normalizeWaitState(
  value: string | undefined,
): BrowserWorkspaceWaitState | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case "hidden":
    case "visible":
      return value.trim().toLowerCase() as BrowserWorkspaceWaitState;
    default:
      return null;
  }
}

function normalizeScrollDirection(
  value: string | undefined,
): BrowserWorkspaceScrollDirection | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case "down":
    case "left":
    case "right":
    case "up":
      return value.trim().toLowerCase() as BrowserWorkspaceScrollDirection;
    default:
      return null;
  }
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function parseNumberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringRecordLike(
  value: unknown,
): Record<string, string> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    return parseStringRecordLike(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseStringArrayLike(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return entries.length > 0 ? entries : undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    return parseStringArrayLike(JSON.parse(value));
  } catch {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

function parseCommandRecord(
  raw: Record<string, unknown>,
): BrowserWorkspaceCommand | null {
  const subaction = normalizeSubaction(
    typeof raw.subaction === "string"
      ? raw.subaction
      : typeof raw.operation === "string"
        ? raw.operation
        : undefined,
  );
  if (!subaction) return null;

  const resolvedFindBy =
    normalizeFindBy(
      typeof raw.findBy === "string"
        ? raw.findBy
        : typeof raw.by === "string"
          ? raw.by
          : typeof raw.label === "string"
            ? "label"
            : undefined,
    ) ?? undefined;
  const rawLabel = typeof raw.label === "string" ? raw.label : undefined;
  const rawTargetText =
    typeof raw.targetText === "string" ? raw.targetText : undefined;
  const rawTextValue = typeof raw.text === "string" ? raw.text : undefined;
  const rawValueValue = typeof raw.value === "string" ? raw.value : undefined;
  const rawOptionValue =
    typeof raw.option === "string" ? raw.option : undefined;
  const usesByLocatorValue =
    typeof raw.by === "string" &&
    typeof raw.findBy !== "string" &&
    typeof raw.label !== "string";
  const writesTextValue = isWriteSubaction(subaction);
  const rawText =
    rawLabel ??
    rawTargetText ??
    (usesByLocatorValue &&
    rawValueValue &&
    (rawTextValue || rawOptionValue || !writesTextValue)
      ? rawValueValue
      : rawTextValue);
  const inferredWriteValue =
    typeof rawText === "string" &&
    ["fill", "keyboardinserttext", "keyboardtype", "select", "type"].includes(
      subaction,
    ) &&
    (typeof raw.selector === "string" ||
      typeof raw.findBy === "string" ||
      typeof raw.label === "string")
      ? rawText
      : undefined;
  const parsedValue =
    rawOptionValue ??
    (writesTextValue && usesByLocatorValue && rawValueValue && rawTextValue
      ? rawTextValue
      : undefined) ??
    rawValueValue ??
    inferredWriteValue;

  return {
    action:
      normalizeFindAction(
        typeof raw.action === "string" ? raw.action : undefined,
      ) ?? undefined,
    subaction,
    baselinePath:
      typeof raw.baselinePath === "string" ? raw.baselinePath : undefined,
    button: typeof raw.button === "string" ? raw.button : undefined,
    clipboardAction:
      typeof raw.clipboardAction === "string" ? raw.clipboardAction : undefined,
    consoleAction:
      typeof raw.consoleAction === "string"
        ? raw.consoleAction
        : typeof raw.action === "string" &&
            ["clear", "list"].includes(raw.action.trim().toLowerCase())
          ? raw.action.trim().toLowerCase()
          : undefined,
    cookieAction:
      typeof raw.cookieAction === "string" ? raw.cookieAction : undefined,
    deltaX: parseNumberLike(raw.deltaX),
    deltaY: parseNumberLike(raw.deltaY),
    device: typeof raw.device === "string" ? raw.device : undefined,
    dialogAction:
      typeof raw.dialogAction === "string" ? raw.dialogAction : undefined,
    diffAction: typeof raw.diffAction === "string" ? raw.diffAction : undefined,
    entryKey: typeof raw.entryKey === "string" ? raw.entryKey : undefined,
    filePath:
      typeof raw.filePath === "string"
        ? raw.filePath
        : typeof raw.path === "string"
          ? raw.path
          : undefined,
    files: parseStringArrayLike(raw.files),
    filter: typeof raw.filter === "string" ? raw.filter : undefined,
    frameAction:
      typeof raw.frameAction === "string" ? raw.frameAction : undefined,
    headers: parseStringRecordLike(raw.headers),
    id: typeof raw.id === "string" ? raw.id : undefined,
    url: typeof raw.url === "string" ? raw.url : undefined,
    secondaryUrl:
      typeof raw.secondaryUrl === "string" ? raw.secondaryUrl : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    script: typeof raw.script === "string" ? raw.script : undefined,
    show: parseBooleanLike(raw.show) ?? parseBooleanLike(raw.visible),
    partition: typeof raw.partition === "string" ? raw.partition : undefined,
    height: parseNumberLike(raw.height),
    direction:
      normalizeScrollDirection(
        typeof raw.direction === "string" ? raw.direction : undefined,
      ) ?? undefined,
    exact: parseBooleanLike(raw.exact),
    findBy: resolvedFindBy,
    index: parseNumberLike(raw.index),
    selector: typeof raw.selector === "string" ? raw.selector : undefined,
    text: rawText,
    value: parsedValue,
    attribute:
      typeof raw.attribute === "string"
        ? raw.attribute
        : typeof raw.attr === "string"
          ? raw.attr
          : undefined,
    key: typeof raw.key === "string" ? raw.key : undefined,
    latitude: parseNumberLike(raw.latitude),
    longitude: parseNumberLike(raw.longitude),
    media: typeof raw.media === "string" ? raw.media : undefined,
    method: typeof raw.method === "string" ? raw.method : undefined,
    mouseAction:
      typeof raw.mouseAction === "string" ? raw.mouseAction : undefined,
    networkAction:
      typeof raw.networkAction === "string" ? raw.networkAction : undefined,
    offline: parseBooleanLike(raw.offline),
    getMode:
      normalizeGetMode(
        typeof raw.getMode === "string"
          ? raw.getMode
          : typeof raw.mode === "string"
            ? raw.mode
            : undefined,
      ) ?? undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    outputPath: typeof raw.outputPath === "string" ? raw.outputPath : undefined,
    pixels: parseNumberLike(raw.pixels),
    profilerAction:
      typeof raw.profilerAction === "string" ? raw.profilerAction : undefined,
    promptText: typeof raw.promptText === "string" ? raw.promptText : undefined,
    requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
    responseBody:
      typeof raw.responseBody === "string" ? raw.responseBody : undefined,
    responseHeaders: parseStringRecordLike(raw.responseHeaders),
    responseStatus: parseNumberLike(raw.responseStatus),
    role:
      typeof raw.role === "string"
        ? raw.role
        : typeof raw.by === "string" &&
            raw.by.trim().toLowerCase() === "role" &&
            typeof raw.name === "string"
          ? "button"
          : undefined,
    scale: parseNumberLike(raw.scale),
    setAction: typeof raw.setAction === "string" ? raw.setAction : undefined,
    state:
      normalizeWaitState(
        typeof raw.state === "string" ? raw.state : undefined,
      ) ?? undefined,
    stateAction:
      typeof raw.stateAction === "string" ? raw.stateAction : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    storageAction:
      typeof raw.storageAction === "string" ? raw.storageAction : undefined,
    storageArea:
      typeof raw.storageArea === "string" ? raw.storageArea : undefined,
    tabAction: typeof raw.tabAction === "string" ? raw.tabAction : undefined,
    timeoutMs:
      parseNumberLike(raw.timeoutMs) ??
      parseNumberLike(raw.ms) ??
      parseNumberLike(raw.milliseconds),
    traceAction:
      typeof raw.traceAction === "string" ? raw.traceAction : undefined,
    width: parseNumberLike(raw.width),
    windowAction:
      typeof raw.windowAction === "string" ? raw.windowAction : undefined,
    x: parseNumberLike(raw.x),
    y: parseNumberLike(raw.y),
    username: typeof raw.username === "string" ? raw.username : undefined,
    password: typeof raw.password === "string" ? raw.password : undefined,
    steps: Array.isArray(raw.steps)
      ? raw.steps
          .map((entry) =>
            entry && typeof entry === "object"
              ? parseCommandRecord(entry as Record<string, unknown>)
              : null,
          )
          .filter((entry): entry is BrowserWorkspaceCommand => Boolean(entry))
      : undefined,
  };
}

function parseStepsParam(
  value: unknown,
): BrowserWorkspaceCommand[] | undefined {
  if (Array.isArray(value)) {
    const steps = value
      .map((entry) =>
        entry && typeof entry === "object"
          ? parseCommandRecord(entry as Record<string, unknown>)
          : null,
      )
      .filter((entry): entry is BrowserWorkspaceCommand => Boolean(entry));
    return steps.length > 0 ? steps : undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseStepsParam(parsed);
  } catch {
    return undefined;
  }
}

export function parseBrowserWorkspaceActionRequest(
  message: Memory,
  options?: HandlerOptions,
): BrowserWorkspaceActionRequest | null {
  const messageText = getMessageText(message);
  const params = (options?.parameters ?? {}) as Record<string, unknown>;
  const fromParams = normalizeSubaction(
    typeof params.subaction === "string"
      ? params.subaction
      : typeof params.operation === "string"
        ? params.operation
        : undefined,
  );
  const url =
    typeof params.url === "string"
      ? params.url
      : (messageText.match(URL_RE)?.[0] ?? undefined);
  const id =
    typeof params.id === "string"
      ? params.id
      : (messageText.match(TAB_ID_RE)?.[1] ?? undefined);
  const steps =
    parseStepsParam(params.steps) ?? parseStepsParam(params.stepsJson);
  const subaction = fromParams ?? (steps ? "batch" : null);
  const resolvedFindBy =
    normalizeFindBy(
      typeof params.findBy === "string"
        ? params.findBy
        : typeof params.by === "string"
          ? params.by
          : typeof params.label === "string"
            ? "label"
            : undefined,
    ) ?? undefined;
  const rawLabel = typeof params.label === "string" ? params.label : undefined;
  const rawTargetText =
    typeof params.targetText === "string" ? params.targetText : undefined;
  const rawTextValue =
    typeof params.text === "string" ? params.text : undefined;
  const rawValueValue =
    typeof params.value === "string" ? params.value : undefined;
  const rawOptionValue =
    typeof params.option === "string" ? params.option : undefined;
  const usesByLocatorValue =
    typeof params.by === "string" &&
    typeof params.findBy !== "string" &&
    typeof params.label !== "string";
  const rawText =
    rawLabel ??
    rawTargetText ??
    (usesByLocatorValue &&
    rawValueValue &&
    (rawTextValue || rawOptionValue || !isWriteSubaction(subaction))
      ? rawValueValue
      : rawTextValue);

  if (!subaction) return null;

  const inferredWriteValue =
    typeof rawText === "string" &&
    isWriteSubaction(subaction) &&
    (typeof params.selector === "string" || typeof params.findBy === "string")
      ? rawText
      : undefined;
  const parsedValue =
    rawOptionValue ??
    (isWriteSubaction(subaction) &&
    usesByLocatorValue &&
    rawValueValue &&
    rawTextValue
      ? rawTextValue
      : undefined) ??
    rawValueValue ??
    inferredWriteValue;

  return {
    action:
      normalizeFindAction(
        typeof params.action === "string" ? params.action : undefined,
      ) ?? undefined,
    subaction,
    baselinePath:
      typeof params.baselinePath === "string" ? params.baselinePath : undefined,
    button: typeof params.button === "string" ? params.button : undefined,
    clipboardAction:
      typeof params.clipboardAction === "string"
        ? params.clipboardAction
        : undefined,
    consoleAction:
      typeof params.consoleAction === "string"
        ? params.consoleAction
        : typeof params.action === "string" &&
            ["clear", "list"].includes(params.action.trim().toLowerCase())
          ? params.action.trim().toLowerCase()
          : undefined,
    cookieAction:
      typeof params.cookieAction === "string" ? params.cookieAction : undefined,
    deltaX: parseNumberLike(params.deltaX),
    deltaY: parseNumberLike(params.deltaY),
    device: typeof params.device === "string" ? params.device : undefined,
    dialogAction:
      typeof params.dialogAction === "string" ? params.dialogAction : undefined,
    diffAction:
      typeof params.diffAction === "string" ? params.diffAction : undefined,
    id,
    url,
    secondaryUrl:
      typeof params.secondaryUrl === "string" ? params.secondaryUrl : undefined,
    title: typeof params.title === "string" ? params.title : undefined,
    script: typeof params.script === "string" ? params.script : undefined,
    show: parseBooleanLike(params.show) ?? parseBooleanLike(params.visible),
    partition:
      typeof params.partition === "string" ? params.partition : undefined,
    entryKey: typeof params.entryKey === "string" ? params.entryKey : undefined,
    filePath:
      typeof params.filePath === "string"
        ? params.filePath
        : typeof params.path === "string"
          ? params.path
          : undefined,
    files: parseStringArrayLike(params.files),
    filter: typeof params.filter === "string" ? params.filter : undefined,
    frameAction:
      typeof params.frameAction === "string" ? params.frameAction : undefined,
    headers: parseStringRecordLike(params.headers),
    height: parseNumberLike(params.height),
    direction:
      normalizeScrollDirection(
        typeof params.direction === "string" ? params.direction : undefined,
      ) ?? undefined,
    exact: parseBooleanLike(params.exact),
    findBy: resolvedFindBy,
    index: parseNumberLike(params.index),
    selector: typeof params.selector === "string" ? params.selector : undefined,
    text: rawText,
    value: parsedValue,
    attribute:
      typeof params.attribute === "string"
        ? params.attribute
        : typeof params.attr === "string"
          ? params.attr
          : undefined,
    key: typeof params.key === "string" ? params.key : undefined,
    latitude: parseNumberLike(params.latitude),
    longitude: parseNumberLike(params.longitude),
    media: typeof params.media === "string" ? params.media : undefined,
    method: typeof params.method === "string" ? params.method : undefined,
    mouseAction:
      typeof params.mouseAction === "string" ? params.mouseAction : undefined,
    networkAction:
      typeof params.networkAction === "string"
        ? params.networkAction
        : undefined,
    offline: parseBooleanLike(params.offline),
    getMode:
      normalizeGetMode(
        typeof params.getMode === "string"
          ? params.getMode
          : typeof params.mode === "string"
            ? params.mode
            : undefined,
      ) ?? undefined,
    name: typeof params.name === "string" ? params.name : undefined,
    outputPath:
      typeof params.outputPath === "string" ? params.outputPath : undefined,
    pixels: parseNumberLike(params.pixels),
    profilerAction:
      typeof params.profilerAction === "string"
        ? params.profilerAction
        : undefined,
    promptText:
      typeof params.promptText === "string" ? params.promptText : undefined,
    requestId:
      typeof params.requestId === "string" ? params.requestId : undefined,
    responseBody:
      typeof params.responseBody === "string" ? params.responseBody : undefined,
    responseHeaders: parseStringRecordLike(params.responseHeaders),
    responseStatus: parseNumberLike(params.responseStatus),
    role:
      typeof params.role === "string"
        ? params.role
        : typeof params.by === "string" &&
            params.by.trim().toLowerCase() === "role" &&
            typeof params.name === "string"
          ? "button"
          : undefined,
    scale: parseNumberLike(params.scale),
    setAction:
      typeof params.setAction === "string" ? params.setAction : undefined,
    state:
      normalizeWaitState(
        typeof params.state === "string" ? params.state : undefined,
      ) ?? undefined,
    stateAction:
      typeof params.stateAction === "string" ? params.stateAction : undefined,
    status: typeof params.status === "string" ? params.status : undefined,
    storageAction:
      typeof params.storageAction === "string"
        ? params.storageAction
        : undefined,
    storageArea:
      typeof params.storageArea === "string" ? params.storageArea : undefined,
    tabAction:
      typeof params.tabAction === "string" ? params.tabAction : undefined,
    timeoutMs:
      parseNumberLike(params.timeoutMs) ??
      parseNumberLike(params.ms) ??
      parseNumberLike(params.milliseconds),
    traceAction:
      typeof params.traceAction === "string" ? params.traceAction : undefined,
    width: parseNumberLike(params.width),
    windowAction:
      typeof params.windowAction === "string" ? params.windowAction : undefined,
    x: parseNumberLike(params.x),
    y: parseNumberLike(params.y),
    username: typeof params.username === "string" ? params.username : undefined,
    password: typeof params.password === "string" ? params.password : undefined,
    steps,
  };
}

function stringifyResult(value: unknown): string {
  try {
    const rendered = JSON.stringify(value);
    if (!rendered) return "null";
    return rendered.length > 320 ? `${rendered.slice(0, 317)}...` : rendered;
  } catch {
    return String(value);
  }
}

function formatBrowserWorkspaceElementLine(
  element: BrowserWorkspaceCommandResult["elements"] extends Array<infer T>
    ? T
    : never,
): string {
  const refPrefix = typeof element.ref === "string" ? `${element.ref} ` : "";
  return `${refPrefix}${element.selector} <${element.tag}> ${element.text || element.value || ""}`.trim();
}

function formatSingleCommandResult(
  result: BrowserWorkspaceCommandResult,
): string {
  switch (result.subaction) {
    case "list": {
      if (!result.tabs?.length) {
        return "Eliza browser workspace has no open tabs.";
      }
      return [
        `Eliza browser workspace has ${result.tabs.length} tab${result.tabs.length === 1 ? "" : "s"} open:`,
        ...result.tabs.map(
          (tab) =>
            `- ${tab.id} [${tab.visible ? "visible" : "background"}] ${tab.url}`,
        ),
      ].join("\n");
    }
    case "open": {
      const tab = result.tab;
      return tab
        ? `Opened ${tab.visible ? "visible" : "background"} browser tab ${tab.id} at ${tab.url}.`
        : "Opened a browser tab.";
    }
    case "navigate": {
      return result.tab
        ? `Navigated ${result.tab.id} to ${result.tab.url}.`
        : "Navigated the browser tab.";
    }
    case "show": {
      return result.tab
        ? `Showing browser tab ${result.tab.id} (${result.tab.url}).`
        : "Showing the browser tab.";
    }
    case "hide": {
      return result.tab
        ? `Moved browser tab ${result.tab.id} into the background.`
        : "Moved the browser tab into the background.";
    }
    case "close":
      return result.closed
        ? "Closed browser tab."
        : "The requested browser tab was not open.";
    case "eval":
      return `Evaluated JavaScript in the browser tab: ${stringifyResult(result.value)}`;
    case "screenshot":
      return `Captured a browser screenshot (${result.snapshot?.data.length ?? 0} base64 chars).`;
    case "snapshot":
      return result.elements?.length
        ? [
            `Captured a browser DOM snapshot at ${stringifyResult(
              result.value && typeof result.value === "object"
                ? (result.value as { url?: string }).url
                : null,
            )}.`,
            ...result.elements
              .slice(0, 8)
              .map(
                (element) => `- ${formatBrowserWorkspaceElementLine(element)}`,
              ),
          ].join("\n")
        : `Captured a browser DOM snapshot: ${stringifyResult(result.value)}`;
    case "inspect": {
      const prefix =
        result.value &&
        typeof result.value === "object" &&
        !Array.isArray(result.value)
          ? (result.value as { title?: string; url?: string })
          : null;
      const head = `Inspected ${prefix?.title ? `${prefix.title} ` : ""}${prefix?.url ? `at ${prefix.url}` : "the current page"}.`;
      if (!result.elements?.length) {
        return `${head} No interactive elements were found.`;
      }
      return [
        head,
        ...result.elements
          .slice(0, 8)
          .map((element) => `- ${formatBrowserWorkspaceElementLine(element)}`),
      ].join("\n");
    }
    case "get":
      return `Read from the browser: ${stringifyResult(result.value)}`;
    case "find":
      return `Found in the browser: ${stringifyResult(result.value)}`;
    case "check":
    case "uncheck":
      return `Updated browser selection: ${stringifyResult(result.value)}`;
    case "fill":
    case "type":
    case "keyboardinserttext":
    case "keyboardtype":
    case "select":
      return `Updated browser input: ${stringifyResult(result.value)}`;
    case "click":
    case "dblclick":
      return `Clicked the browser element: ${stringifyResult(result.value)}`;
    case "focus":
      return `Focused a browser element: ${stringifyResult(result.value)}`;
    case "hover":
      return `Hovered a browser element: ${stringifyResult(result.value)}`;
    case "press":
    case "keydown":
    case "keyup":
      return `Sent a key press in the browser: ${stringifyResult(result.value)}`;
    case "wait":
      return `Wait condition satisfied in the browser: ${stringifyResult(result.value)}`;
    case "scroll":
    case "scrollinto":
      return `Scrolled in the browser: ${stringifyResult(result.value)}`;
    case "clipboard":
      return `Updated the browser clipboard: ${stringifyResult(result.value)}`;
    case "console":
      return `Read browser console entries: ${stringifyResult(result.value)}`;
    case "cookies":
      return `Read browser cookies: ${stringifyResult(result.value)}`;
    case "diff":
      return `Compared browser state: ${stringifyResult(result.value)}`;
    case "dialog":
      return `Handled browser dialog state: ${stringifyResult(result.value)}`;
    case "drag":
      return `Dragged within the browser: ${stringifyResult(result.value)}`;
    case "errors":
      return `Read browser errors: ${stringifyResult(result.value)}`;
    case "frame":
      return `Changed browser frame context: ${stringifyResult(result.value)}`;
    case "highlight":
      return `Highlighted a browser element: ${stringifyResult(result.value)}`;
    case "mouse":
      return `Moved the browser mouse: ${stringifyResult(result.value)}`;
    case "network":
      return `Updated browser network state: ${stringifyResult(result.value)}`;
    case "pdf":
      return `Saved browser PDF output: ${stringifyResult(result.value)}`;
    case "profiler":
      return `Updated browser profiling state: ${stringifyResult(result.value)}`;
    case "set":
      return `Updated browser settings: ${stringifyResult(result.value)}`;
    case "state":
      return `Updated browser session state: ${stringifyResult(result.value)}`;
    case "storage":
      return `Read browser storage: ${stringifyResult(result.value)}`;
    case "tab":
      return result.closed
        ? "Closed browser tab through tab controls."
        : result.tab
          ? `Updated browser tabs: ${result.tab.id}`
          : `Read browser tabs: ${stringifyResult(result.tabs ?? result.value)}`;
    case "trace":
      return `Updated browser tracing state: ${stringifyResult(result.value)}`;
    case "upload":
      return `Uploaded files in the browser: ${stringifyResult(result.value)}`;
    case "window":
      return result.tab
        ? `Opened a new browser window/tab ${result.tab.id} at ${result.tab.url}.`
        : `Opened a new browser window/tab: ${stringifyResult(result.value)}`;
    case "back":
      return `Moved the browser tab back: ${stringifyResult(result.value)}`;
    case "forward":
      return `Moved the browser tab forward: ${stringifyResult(result.value)}`;
    case "reload":
      return `Reloaded the browser tab: ${stringifyResult(result.value)}`;
    default:
      return stringifyResult(result.value);
  }
}

function formatBrowserWorkspaceCommandResult(
  result: BrowserWorkspaceCommandResult,
): string {
  if (result.subaction !== "batch") {
    return formatSingleCommandResult(result);
  }

  const steps = Array.isArray(result.steps) ? result.steps : [];
  if (steps.length === 0) {
    return "Completed an empty browser batch.";
  }

  return [
    `Completed ${steps.length} browser subaction${steps.length === 1 ? "" : "s"}.`,
    ...steps.map((step) => `- ${formatSingleCommandResult(step)}`),
  ].join("\n");
}

export const manageElizaBrowserWorkspaceAction: Action = {
  name: "MANAGE_ELIZA_BROWSER_WORKSPACE",
  contexts: ["browser", "web", "files", "code", "automation"],
  contextGate: { anyOf: ["browser", "web", "files", "code", "automation"] },
  description: JSON.stringify({
    browser_workspace_action: {
      purpose:
        "Control the Eliza browser workspace through one compact router action.",
      subactions: EXPLICIT_SUBACTIONS,
      provider_state:
        "Read-only tab and wallet state is available from the app_browser_workspace provider. Use list/state only when explicitly refreshing live browser state.",
      batch:
        "Use batch with stepsJson to run browser subactions in order. stepsJson remains a JSON string because the route command parser consumes JSON.",
      refs: "snapshot and inspect return reusable element refs such as @e1 for selector values.",
    },
  }),
  descriptionCompressed:
    "Browser workspace: navigate/click/type/fill | screenshot/snapshot/inspect/dom | tabs/cookies/storage/network/console | eval | batch.",
  similes: [
    "browser command",
    "browser subaction",
    "open browser tab",
    "inspect browser page",
    "click browser element",
  ],
  parameters: [
    {
      name: "subaction",
      description:
        "Browser subaction to run: list, open, navigate, show, hide, close, inspect, snapshot, screenshot, find, click, dblclick, fill, type, keyboardtype, keyboardinserttext, focus, hover, select, check, uncheck, press, keydown, keyup, scroll, scrollinto, wait, get, back, forward, reload, eval, batch, clipboard, mouse, drag, upload, set, cookies, storage, network, dialog, console, errors, highlight, diff, trace, profiler, state, frame, tab, window, or pdf.",
      required: false,
      schema: {
        type: "string",
        enum: [
          "list",
          "open",
          "navigate",
          "show",
          "hide",
          "close",
          "inspect",
          "snapshot",
          "screenshot",
          "find",
          "click",
          "dblclick",
          "fill",
          "type",
          "keyboardtype",
          "keyboardinserttext",
          "focus",
          "hover",
          "select",
          "check",
          "uncheck",
          "press",
          "keydown",
          "keyup",
          "scroll",
          "scrollinto",
          "wait",
          "get",
          "back",
          "forward",
          "reload",
          "eval",
          "batch",
          "clipboard",
          "mouse",
          "drag",
          "upload",
          "set",
          "cookies",
          "storage",
          "network",
          "dialog",
          "console",
          "errors",
          "highlight",
          "diff",
          "trace",
          "profiler",
          "state",
          "frame",
          "tab",
          "window",
          "pdf",
        ],
      },
    },
    {
      name: "operation",
      description:
        "Legacy alias for subaction. Prefer subaction for all new browser calls.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "id",
      description:
        "Optional browser workspace tab ID, such as btab_1. Omit it to target the current visible tab.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "url",
      description: "Target URL to open, navigate to, or wait for.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "selector",
      description:
        "CSS selector or reusable snapshot ref like @e1 for browser element subactions.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "text",
      description:
        "Visible text matcher for browser element subactions when selector is not available.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "value",
      description: "Value to fill, type, or otherwise pass to the browser.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "attribute",
      description: "Attribute name for get attr lookups.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "getMode",
      description:
        "Lookup mode for get: text, html, value, attr, title, url, count, box, styles, visible, enabled, or checked.",
      required: false,
      schema: {
        type: "string",
        enum: [
          "text",
          "html",
          "value",
          "attr",
          "title",
          "url",
          "count",
          "box",
          "styles",
          "visible",
          "enabled",
          "checked",
        ],
      },
    },
    {
      name: "findBy",
      description:
        "Semantic locator strategy for find: role, text, label, placeholder, alt, title, testid, first, last, or nth.",
      required: false,
      schema: {
        type: "string",
        enum: [
          "role",
          "text",
          "label",
          "placeholder",
          "alt",
          "title",
          "testid",
          "first",
          "last",
          "nth",
        ],
      },
    },
    {
      name: "action",
      description:
        "Optional action for find: text, click, fill, type, focus, hover, check, or uncheck.",
      required: false,
      schema: {
        type: "string",
        enum: [
          "text",
          "click",
          "fill",
          "type",
          "focus",
          "hover",
          "check",
          "uncheck",
        ],
      },
    },
    {
      name: "role",
      description: "Role name for findBy=role, such as button or textbox.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "name",
      description:
        "Accessible name matcher for findBy=role, or a secondary semantic name when needed.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "exact",
      description: "Whether semantic text matching should be exact.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "index",
      description: "Zero-based index for findBy=nth.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "key",
      description: "Keyboard key for press, such as Enter or Tab.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "state",
      description: "Optional wait state for selector waits: visible or hidden.",
      required: false,
      schema: { type: "string", enum: ["visible", "hidden"] },
    },
    {
      name: "direction",
      description: "Scroll direction for scroll subactions.",
      required: false,
      schema: { type: "string", enum: ["up", "down", "left", "right"] },
    },
    {
      name: "pixels",
      description: "Scroll distance in pixels for scroll subactions.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "script",
      description: "JavaScript source to run for eval subactions.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "stepsJson",
      description:
        'JSON array of browser subaction objects for batch mode. Example: [{"subaction":"open","url":"https://example.com","show":true},{"subaction":"inspect"}]',
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeoutMs",
      description:
        "Optional timeout in milliseconds for wait subactions. When no selector/text/url/script condition is provided, wait sleeps for this duration.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "ms",
      description:
        "Alias for timeoutMs, useful for timed waits that simply sleep for a number of milliseconds.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "show",
      description: "Whether a newly opened tab should be visible immediately.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "title",
      description: "Optional browser tab title override when opening a tab.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "partition",
      description: "Optional browser partition to use for the tab session.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "filePath",
      description:
        "Optional output/input path for pdf, trace, profiler, state save/load, screenshot output, or HAR capture.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "files",
      description: "Optional file path array for upload subactions.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "headers",
      description:
        "Optional string map for set headers or mocked network response headers.",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "clipboardAction",
      description: "Clipboard mode: read, write, copy, or paste.",
      required: false,
      schema: { type: "string", enum: ["read", "write", "copy", "paste"] },
    },
    {
      name: "mouseAction",
      description: "Mouse mode: move, down, up, or wheel.",
      required: false,
      schema: { type: "string", enum: ["move", "down", "up", "wheel"] },
    },
    {
      name: "setAction",
      description:
        "Browser settings mode: viewport, device, geo, offline, headers, credentials, or media.",
      required: false,
      schema: {
        type: "string",
        enum: [
          "viewport",
          "device",
          "geo",
          "offline",
          "headers",
          "credentials",
          "media",
        ],
      },
    },
    {
      name: "storageAction",
      description: "Storage mode: get, set, or clear.",
      required: false,
      schema: { type: "string", enum: ["get", "set", "clear"] },
    },
    {
      name: "storageArea",
      description: "Storage target: local or session.",
      required: false,
      schema: { type: "string", enum: ["local", "session"] },
    },
    {
      name: "networkAction",
      description:
        "Network mode: route, unroute, requests, request, harstart, or harstop.",
      required: false,
      schema: {
        type: "string",
        enum: [
          "route",
          "unroute",
          "requests",
          "request",
          "harstart",
          "harstop",
        ],
      },
    },
    {
      name: "dialogAction",
      description: "Dialog mode: status, accept, or dismiss.",
      required: false,
      schema: { type: "string", enum: ["status", "accept", "dismiss"] },
    },
    {
      name: "diffAction",
      description: "Diff mode: snapshot, screenshot, or url.",
      required: false,
      schema: { type: "string", enum: ["snapshot", "screenshot", "url"] },
    },
    {
      name: "traceAction",
      description: "Trace mode: start or stop.",
      required: false,
      schema: { type: "string", enum: ["start", "stop"] },
    },
    {
      name: "profilerAction",
      description: "Profiler mode: start or stop.",
      required: false,
      schema: { type: "string", enum: ["start", "stop"] },
    },
    {
      name: "stateAction",
      description: "State mode: save or load.",
      required: false,
      schema: { type: "string", enum: ["save", "load"] },
    },
    {
      name: "frameAction",
      description: "Frame mode: select or main.",
      required: false,
      schema: { type: "string", enum: ["select", "main"] },
    },
    {
      name: "tabAction",
      description: "Tab mode: list, new, switch, or close.",
      required: false,
      schema: { type: "string", enum: ["list", "new", "switch", "close"] },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state,
    options?: HandlerOptions,
  ) => parseBrowserWorkspaceActionRequest(message, options) !== null,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ) => {
    const maxBrowserBatchSteps = 25;
    const maxActionResultBytes = 6000;
    const request = parseBrowserWorkspaceActionRequest(message, options);
    if (!request) {
      const text =
        "subaction is required. Pass an explicit subaction (and any needed selector/url/value), or use batch with stepsJson.";
      await callback?.({ text });
      return { success: false, text };
    }

    if (request.subaction === "batch") {
      const steps = request.steps ?? [];
      if (steps.length === 0) {
        const text =
          "Browser batch mode requires stepsJson with at least one subaction step.";
        await callback?.({ text });
        return { success: false, text };
      }

      try {
        const parentCtx = getTrajectoryContext();
        const stepResults: BrowserWorkspaceCommandResult[] = [];
        for (const step of steps) {
          const stepResult = await runWithTrajectoryContext(
            {
              ...(parentCtx ?? {}),
              purpose: `browser-batch-step:${step.subaction}`,
            },
            () => executeBrowserWorkspaceCommand(step),
          );
          stepResults.push(stepResult);
        }
        const result: BrowserWorkspaceCommandResult = {
          mode: getBrowserWorkspaceMode(),
          subaction: "batch",
          steps: stepResults.slice(0, maxBrowserBatchSteps),
          value: stepResults.at(-1)?.value,
        };
        const text = formatBrowserWorkspaceCommandResult(result).slice(0, maxActionResultBytes);
        await callback?.({ text });
        return { success: true, text, data: result };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await callback?.({ text });
        return { success: false, text };
      }
    }

    try {
      const result = await executeBrowserWorkspaceCommand(request);
      const text = formatBrowserWorkspaceCommandResult(result).slice(0, maxActionResultBytes);
      await callback?.({ text });
      return { success: true, text, data: result };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await callback?.({ text });
      return { success: false, text };
    }
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Use one browser action to open https://example.com, inspect the page, and read the h1 text.",
        },
      },
      {
        name: "assistant",
        content: {
          text: 'Completed 3 browser subactions.\n- Opened visible browser tab btab_1 at https://example.com/.\n- Inspected Example Domain at https://example.com/.\n- Read from the browser: "Example Domain"',
        },
      },
    ],
  ] as ActionExample[][],
};
