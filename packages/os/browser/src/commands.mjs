/** Executes fixed browser operations against explicit tabs and isolated-world snapshot references. */
import { BridgeError } from "./protocol.mjs";

function pageCommand(command, snapshotId) {
  const key = "__elizaBrowserControlV1";
  if (command.subaction === "snapshot") {
    const nodes = new Map();
    const elements = [];
    const candidates = document.querySelectorAll(
      "a,button,input,textarea,select,[role=button],[role=textbox],[contenteditable=true],summary",
    );
    for (const node of candidates) {
      const id = String(nodes.size);
      nodes.set(id, node);
      elements.push({
        id,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role"),
        label:
          node.getAttribute("aria-label") ||
          node.getAttribute("placeholder") ||
          (node instanceof HTMLInputElement && node.type === "password"
            ? "Password"
            : node.textContent),
        type: node.getAttribute("type"),
        heading: node.querySelector("h1,h2,h3,h4,h5,h6")?.textContent ?? null,
        href:
          node instanceof HTMLAnchorElement && /^https?:/.test(node.href)
            ? node.href
            : null,
      });
    }
    globalThis[key] = { snapshotId, nodes, document };
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      text: document.body?.innerText ?? document.documentElement.textContent,
      complete: true,
      omitted: ["form control values (credential boundary)"],
      elements,
    };
  }
  const state = globalThis[key];
  if (
    !state ||
    state.snapshotId !== command.snapshotId ||
    state.document !== document
  )
    return {
      error: {
        kind: "STALE_REF",
        message: "Read a fresh snapshot of this tab.",
      },
    };
  const node = state.nodes.get(command.nodeId);
  if (!node?.isConnected)
    return {
      error: {
        kind: "STALE_REF",
        message: "The referenced page element no longer exists.",
      },
    };
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

export async function executeCommand(api, command, prepared) {
  const action = command.subaction;
  if (action === "list")
    return {
      tabs: (await api.tabs.query({}))
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
    const context = prepared ?? (await prepareCommand(api, command));
    const tab = await api.tabs.create({
      url: command.url,
      active: false,
      windowId: context.windowId,
    });
    return {
      id: String(tab.id),
      dispatched: true,
      completed: false,
      requiresReadback: true,
    };
  }
  const tabId = Number(command.id);
  let tab = await api.tabs.get(tabId);
  if (action === "snapshot") {
    const deadline = Date.now() + 15000;
    while (
      (!/^https?:/.test(tab.url ?? "") || tab.status === "loading") &&
      /^https?:/.test(tab.pendingUrl ?? tab.url ?? "") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      tab = await api.tabs.get(tabId);
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
  if (action === "navigate") await api.tabs.update(tabId, { url: command.url });
  else if (action === "close") await api.tabs.remove(tabId);
  else if (action === "back") await api.tabs.goBack(tabId);
  else if (action === "forward") await api.tabs.goForward(tabId);
  else if (action === "reload") await api.tabs.reload(tabId);
  else if (action === "snapshot") {
    const snapshotId = crypto.randomUUID();
    const before = await api.webNavigation.getAllFrames({ tabId });
    if (
      !before?.length ||
      before.some((frame) => frame.errorOccurred || !frame.documentId)
    )
      throw new BridgeError(
        "INCOMPLETE_SNAPSHOT",
        "The browser could not inventory every frame document.",
      );
    const frames = await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageCommand,
      args: [command, snapshotId],
      world: "ISOLATED",
    });
    const after = await api.webNavigation.getAllFrames({ tabId });
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
      frames: frames.map(({ frameId, result, error }) => {
        if (error || !result?.complete)
          throw new BridgeError(
            "INCOMPLETE_SNAPSHOT",
            "A frame could not be read completely; no partial snapshot is returned.",
          );
        return {
          frameId,
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
    const [result] = await api.scripting.executeScript({
      target: { tabId, frameIds: [Number(match[2])] },
      func: pageCommand,
      args: [{ ...command, snapshotId: match[1], nodeId: match[3] }, null],
      world: "ISOLATED",
    });
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
