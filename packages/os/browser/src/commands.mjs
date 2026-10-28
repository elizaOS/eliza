/** Executes fixed browser operations against explicit tabs and isolated-world snapshot references. */

import { blockerSelectors, pageCommand } from "./page-command.mjs";
import { BridgeError } from "./protocol.mjs";

export { COMMIT_CONTROL, pageCommand } from "./page-command.mjs";

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
  if (action === "list") {
    const all = await read(() => api.tabs.query({}));
    return {
      tabs: all
        .filter((tab) => /^https?:/.test(tab.url ?? ""))
        .map((tab) => ({
          id: String(tab.id),
          url: tab.url,
          title: tab.title,
          active: tab.active,
          windowId: tab.windowId,
        })),
      // Windows counted before the filter: a window that holds only a new-tab,
      // settings or PDF page is still a window she may be looking at.
      windowCount: new Set(all.map((tab) => tab.windowId)).size,
    };
  }
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
        "page-loading",
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
    // The page she sees is the tab's active document. Chromium also lists documents it has
    // not shown (a prerendered search warmup, a cached page); script injection never reaches
    // them, so counting them failed every read while one was attached.
    const pageFrames = (inventory) =>
      inventory?.filter(
        (frame) =>
          (frame.documentLifecycle ?? "active") === "active" &&
          (!command.taskPolicy || frame.frameId === 0),
      );
    const before = pageFrames(
      await read(() => api.webNavigation.getAllFrames({ tabId })),
    );
    if (
      !before?.length ||
      before.some((frame) => frame.errorOccurred || !frame.documentId)
    )
      throw new BridgeError(
        "INCOMPLETE_SNAPSHOT",
        "The browser could not inventory every frame document.",
        "frame-inventory-incomplete",
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
    const after = pageFrames(
      await read(() => api.webNavigation.getAllFrames({ tabId })),
    );
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
        "frame-identity-changed",
      );
    return {
      id: command.id,
      snapshotId,
      frames: frames.map(({ frameId, documentId, result, error }) => {
        if (error || !result?.complete)
          throw new BridgeError(
            "INCOMPLETE_SNAPSHOT",
            "A frame could not be read completely; no partial snapshot is returned.",
            "frame-read-incomplete",
          );
        return {
          frameId,
          documentId,
          ...result,
          elements: result.elements.map(({ id, ...element }) => ({
            ...element,
            selector: `${snapshotId}:${frameId}:${id}`,
          })),
          blockers: blockerSelectors(
            result.blockers,
            `${snapshotId}:${frameId}`,
          ),
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
