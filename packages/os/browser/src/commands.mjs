/** Executes fixed browser operations against explicit tabs and isolated-world snapshot references. */
import { BridgeError } from "./protocol.mjs";

export function pageCommand(command, snapshotId, validateOnly = false) {
  const policy = command.taskPolicy;
  const denied = () => ({
    error: {
      kind: "POLICY_BLOCKED",
      message:
        "This action requires the person or a new authorized task observation.",
    },
  });
  if (
    policy &&
    (window !== window.top ||
      location.origin !== policy.origin ||
      Date.now() >= policy.expiresAt)
  )
    return denied();
  const key = "__elizaBrowserControlV1";
  const monitorKey = "__elizaBrowserObservationV1";
  let monitor = globalThis[monitorKey];
  if (!monitor || monitor.document !== document) {
    monitor = {
      document,
      domRevision: 0,
      inputRevision: 0,
      ownedHosts: new WeakSet(),
    };
    monitor.recordMutations = (records) => {
      if (
        records.some(
          (record) =>
            !(
              record.type === "childList" &&
              record.target === document.documentElement &&
              [...record.addedNodes, ...record.removedNodes].length > 0 &&
              [...record.addedNodes, ...record.removedNodes].every((node) =>
                monitor.ownedHosts.has(node),
              )
            ),
        )
      )
        monitor.domRevision++;
    };
    monitor.observer = new MutationObserver(monitor.recordMutations);
    monitor.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const input = () => {
      monitor.inputRevision++;
    };
    document.addEventListener("beforeinput", input, true);
    document.addEventListener("input", input, true);
    document.addEventListener("change", input, true);
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.isTrusted) input();
      },
      true,
    );
    globalThis[monitorKey] = monitor;
  }
  // Drain queued mutations synchronously as an effect may arrive before the
  // MutationObserver microtask. Never store or return form values in this monitor.
  monitor.recordMutations(monitor.observer.takeRecords());
  const bounds = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const viewport = () => ({
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    devicePixelRatio,
    scale: visualViewport?.scale ?? 1,
    offsetLeft: visualViewport?.offsetLeft ?? 0,
    offsetTop: visualViewport?.offsetTop ?? 0,
  });
  if (command.subaction === "snapshot") {
    const readVisibleText = (root) => {
      const visibleText = [];
      const collectText = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const visibility = node.parentElement
            ? getComputedStyle(node.parentElement).visibility
            : "visible";
          if (
            visibility !== "hidden" &&
            visibility !== "collapse" &&
            node.textContent.trim()
          )
            visibleText.push(node.textContent);
          return;
        }
        if (!(node instanceof Element)) return;
        if (
          node.matches("input,textarea,select,script,style,noscript") ||
          node.isContentEditable
        )
          return;
        const style = getComputedStyle(node);
        if (style.display === "none") return;
        for (const child of node.childNodes) collectText(child);
      };
      collectText(root);
      return visibleText.join("\n").trim();
    };
    const nodes = new Map();
    const elements = [];
    const candidates = document.querySelectorAll(
      "a,button,input,textarea,select,[role=button],[role=textbox],[contenteditable=true],summary",
    );
    for (const node of candidates) {
      const id = String(nodes.size);
      const geometry = bounds(node);
      // This equality sentinel never leaves the isolated page realm.
      nodes.set(id, {
        node,
        bounds: geometry,
        value: typeof node.value === "string" ? node.value : null,
      });
      elements.push({
        bounds: geometry,
        id,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role"),
        label:
          node.getAttribute("aria-label") ||
          node.getAttribute("placeholder") ||
          (node instanceof HTMLInputElement && node.type === "password"
            ? "Password"
            : node instanceof HTMLTextAreaElement ||
                node instanceof HTMLSelectElement ||
                node.isContentEditable
              ? ""
              : readVisibleText(node)),
        type: node.getAttribute("type"),
        heading: node.querySelector("h1,h2,h3,h4,h5,h6")
          ? readVisibleText(node.querySelector("h1,h2,h3,h4,h5,h6"))
          : null,
        href:
          node instanceof HTMLAnchorElement && /^https?:/.test(node.href)
            ? node.href
            : null,
      });
    }
    globalThis[key] = {
      snapshotId,
      nodes,
      document,
      url: location.href,
      domRevision: monitor.domRevision,
      inputRevision: monitor.inputRevision,
      viewport: viewport(),
    };
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      domRevision: monitor.domRevision,
      inputRevision: monitor.inputRevision,
      viewport: viewport(),
      text: readVisibleText(document.body ?? document.documentElement),
      complete: true,
      omitted: [
        "form control values and editable region contents (credential boundary)",
      ],
      elements,
    };
  }
  const state = globalThis[key];
  if (
    !state ||
    state.snapshotId !== command.snapshotId ||
    state.document !== document ||
    state.url !== location.href ||
    state.domRevision !== monitor.domRevision ||
    state.inputRevision !== monitor.inputRevision ||
    JSON.stringify(state.viewport) !== JSON.stringify(viewport())
  )
    return {
      error: {
        kind: "STALE_REF",
        message: "Read a fresh snapshot of this tab.",
      },
    };
  const recorded = state.nodes.get(command.nodeId);
  const node = recorded?.node;
  if (
    !node?.isConnected ||
    recorded.value !== (typeof node.value === "string" ? node.value : null) ||
    JSON.stringify(recorded.bounds) !== JSON.stringify(bounds(node))
  )
    return {
      error: {
        kind: "STALE_REF",
        message: "The referenced page element changed; read a fresh snapshot.",
      },
    };
  if (policy) {
    // The native host supplies reviewed target permissions; DOM text cannot
    // grant an action. Re-check the actual node immediately before the effect.
    if (
      !policy.targets.some((target) => {
        const permission =
          command.subaction === "fill" &&
          policy.protectedValueKind === "verification-code"
            ? "fill-code"
            : command.subaction;
        if (target.action !== permission) return false;
        try {
          const matches = document.querySelectorAll(target.selector);
          return matches.length === 1 && matches[0] === node;
        } catch {
          return false;
        }
      })
    )
      return denied();
    const label = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`;
    if (
      command.subaction === "click" &&
      (node.matches(
        "button:not([type=button]):not([type=reset]),input[type=submit],input[type=image],input[type=password]",
      ) ||
        /\b(sign\s*in|log\s*in|verify|pay|purchase|place\s+order|submit)\b/i.test(
          label,
        ))
    )
      return denied();
    if (
      command.subaction === "fill" &&
      (!(
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement
      ) ||
        (node instanceof HTMLInputElement &&
          !["text", "email", "tel", "number", "search", "url"].includes(
            node.type,
          )) ||
        (policy.protectedValueKind === "verification-code"
          ? !(node instanceof HTMLInputElement) ||
            node.autocomplete !== "one-time-code" ||
            !/^[A-Za-z0-9]{4,12}$/.test(command.text)
          : /(?:password|one-time-code|cc-)/i.test(node.autocomplete || "")))
    )
      return denied();
  }
  if (command.subaction === "fill" && (node.disabled || node.readOnly))
    return denied();
  if (validateOnly) return { validated: true };
  if (policy?.actionId) {
    const feedback = globalThis.__elizaPageGuidanceV1;
    if (
      !feedback?.actionReady?.(
        policy.actionId,
        command.snapshotId,
        command.nodeId,
        command.subaction,
      )
    )
      return denied();
    feedback.markActed();
  }
  delete globalThis[key];
  if (command.subaction === "click") {
    node.click();
  } else if (command.subaction === "fill") {
    if (
      !(
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement
      ) ||
      node.disabled ||
      node.readOnly
    )
      return {
        error: {
          kind: "UNSUPPORTED",
          message: "The target is not an editable form control.",
        },
      };
    const prototype =
      node instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(
      node,
      command.text,
    );
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (command.subaction === "scroll") {
    node.scrollBy({
      top:
        command.direction === "up"
          ? -500
          : command.direction === "down"
            ? 500
            : 0,
      left:
        command.direction === "left"
          ? -500
          : command.direction === "right"
            ? 500
            : 0,
      behavior: "instant",
    });
  }
  return { dispatched: true, completed: false, requiresReadback: true };
}

/** Resolves required browser context without admitting or performing an effect. */
export async function prepareCommand(api, command) {
  if (command.subaction !== "open") return {};
  const windows = (
    await api.windows.getAll({ windowTypes: ["normal"] })
  ).filter((window) => window.type === "normal" && Number.isInteger(window.id));
  const window = windows.find((candidate) => candidate.focused) ?? windows[0];
  if (!window)
    throw new BridgeError(
      "UNAVAILABLE",
      "Open Chromium from your launcher once, then request a new background tab. No browser window is available; this command was not performed.",
    );
  return { windowId: window.id };
}

export async function executeCommand(
  api,
  command,
  prepared,
  isCurrent = () => true,
) {
  const requireCurrent = () => {
    if (!isCurrent())
      throw new BridgeError(
        "STALE_REF",
        "The browser command context ended before dispatch; observe again under the current context.",
      );
  };
  const read = async (operation) => {
    requireCurrent();
    const value = await operation();
    requireCurrent();
    return value;
  };
  const effect = async (operation) => {
    requireCurrent();
    const value = await operation();
    if (!isCurrent())
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "The browser command context ended after dispatch; inspect the same tab without replaying the effect.",
      );
    return value;
  };
  requireCurrent();
  const action = command.subaction;
  if (action === "list")
    return {
      tabs: (await read(() => api.tabs.query({})))
        .filter((tab) => /^https?:/.test(tab.url ?? ""))
        .map((tab) => ({
          id: String(tab.id),
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId,
        })),
    };
  if (action === "open") {
    const context =
      prepared ?? (await read(() => prepareCommand(api, command)));
    const tab = await effect(() =>
      api.tabs.create({
        url: command.url,
        active: false,
        windowId: context.windowId,
      }),
    );
    return {
      id: String(tab.id),
      dispatched: true,
      completed: false,
      requiresReadback: true,
    };
  }
  const tabId = Number(command.id);
  let tab = await read(() => api.tabs.get(tabId));
  if (action === "snapshot") {
    const deadline = Date.now() + 15000;
    while (
      (!/^https?:/.test(tab.url ?? "") || tab.status === "loading") &&
      /^https?:/.test(tab.pendingUrl ?? tab.url ?? "") &&
      Date.now() < deadline
    ) {
      await read(() => new Promise((resolve) => setTimeout(resolve, 50)));
      tab = await read(() => api.tabs.get(tabId));
    }
    if (tab.status === "loading")
      throw new BridgeError(
        "UNAVAILABLE",
        "The exact browser tab is still loading; read it again without repeating navigation.",
      );
  }
  if (!/^https?:/.test(tab.url ?? ""))
    throw new BridgeError(
      "POLICY_BLOCKED",
      "Browser-internal pages cannot be controlled.",
    );
  if (action === "navigate")
    await effect(() => api.tabs.update(tabId, { url: command.url }));
  else if (action === "close") await effect(() => api.tabs.remove(tabId));
  else if (action === "back") await effect(() => api.tabs.goBack(tabId));
  else if (action === "forward") await effect(() => api.tabs.goForward(tabId));
  else if (action === "reload") await effect(() => api.tabs.reload(tabId));
  else if (action === "snapshot") {
    const snapshotId = crypto.randomUUID();
    const before = (
      await read(() => api.webNavigation.getAllFrames({ tabId }))
    )?.filter((frame) => !command.taskPolicy || frame.frameId === 0);
    if (
      !before?.length ||
      before.some((frame) => frame.errorOccurred || !frame.documentId)
    )
      throw new BridgeError(
        "INCOMPLETE_SNAPSHOT",
        "The browser could not inventory every frame document.",
      );
    const frames = await read(() =>
      api.scripting.executeScript({
        target: command.taskPolicy
          ? { tabId, frameIds: [0] }
          : { tabId, allFrames: true },
        func: pageCommand,
        args: [command, snapshotId],
        world: "ISOLATED",
      }),
    );
    const after = (
      await read(() => api.webNavigation.getAllFrames({ tabId }))
    )?.filter((frame) => !command.taskPolicy || frame.frameId === 0);
    if (
      !after ||
      before.length !== after.length ||
      frames.length !== before.length ||
      before.some(
        (frame) =>
          !after.some(
            (current) =>
              current.frameId === frame.frameId &&
              current.documentId === frame.documentId,
          ) ||
          !frames.some(
            (read) =>
              read.frameId === frame.frameId &&
              read.documentId === frame.documentId,
          ),
      )
    )
      throw new BridgeError(
        "INCOMPLETE_SNAPSHOT",
        "A frame was inaccessible or changed during the read; no partial snapshot is returned.",
      );
    return {
      id: command.id,
      snapshotId,
      frames: frames.map(({ frameId, documentId, result, error }) => {
        if (error || !result?.complete)
          throw new BridgeError(
            "INCOMPLETE_SNAPSHOT",
            "A frame could not be read completely; no partial snapshot is returned.",
          );
        return {
          frameId,
          documentId,
          ...result,
          elements: result.elements.map(({ id, ...element }) => ({
            ...element,
            selector: `${snapshotId}:${frameId}:${id}`,
          })),
        };
      }),
    };
  } else {
    const match = /^([0-9a-f-]{36}):(\d+):(\d+)$/.exec(command.selector);
    if (!match)
      throw new BridgeError(
        "STALE_REF",
        "Use a selector from the latest snapshot.",
      );
    const [result] = await effect(() =>
      api.scripting.executeScript({
        target: { tabId, frameIds: [Number(match[2])] },
        func: pageCommand,
        args: [{ ...command, snapshotId: match[1], nodeId: match[3] }, null],
        world: "ISOLATED",
      }),
    );
    if (result?.result?.error)
      throw new BridgeError(
        result.result.error.kind,
        result.result.error.message,
      );
    if (!result?.result?.dispatched)
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "No effect receipt arrived; inspect the same tab before retrying.",
      );
    return result.result;
  }
  return {
    id: command.id,
    dispatched: true,
    completed: false,
    requiresReadback: true,
  };
}
