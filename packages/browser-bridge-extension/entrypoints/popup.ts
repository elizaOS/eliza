/**
 * Renders the extension's compact connection status and exposes only
 * contextual recovery, permission, and disconnect controls.
 */
import {
  derivePopupStatusModel,
  type PopupContextualAction,
  requiredCurrentSiteOriginPattern,
} from "../src/popup-model";
import type {
  BackgroundState,
  PopupRequest,
  PopupResponse,
} from "../src/protocol";
import {
  hasAllUrlHostPermission,
  hasWebsiteAccess,
  queryTabs,
  requestAllWebsiteAccess,
  requestWebsiteAccess,
  sendRuntimeMessage,
} from "../src/webextension";

type PopupRefs = {
  statusTitle: HTMLElement;
  primaryAction: HTMLButtonElement;
  details: HTMLDetailsElement;
  disconnectButton: HTMLButtonElement;
};

type ElementConstructor<T extends HTMLElement> = { new (): T };

function requireElement<T extends HTMLElement>(
  selector: string,
  elementConstructor: ElementConstructor<T>,
): T {
  const element = document.querySelector(selector);
  if (!(element instanceof elementConstructor)) {
    throw new Error(`Missing element ${selector}`);
  }
  return element;
}

function getPopupRefs(): PopupRefs {
  return {
    statusTitle: requireElement("#statusTitle", HTMLElement),
    primaryAction: requireElement("#primaryAction", HTMLButtonElement),
    details: requireElement("#details", HTMLDetailsElement),
    disconnectButton: requireElement("#disconnect", HTMLButtonElement),
  };
}

function popupResponseError(response: PopupResponse): string {
  return "error" in response
    ? response.error
    : "The browser bridge returned an incomplete success response.";
}

async function sendMessage<T extends PopupRequest>(
  request: T,
): Promise<PopupResponse> {
  return await sendRuntimeMessage<PopupResponse>(request);
}

let currentAction: PopupContextualAction | null = null;
let currentSiteOriginPattern: string | null = null;

async function resolveCurrentSitePermission(args: {
  state: BackgroundState;
}): Promise<{ required: boolean; pattern: string | null }> {
  const [activeTab] = await queryTabs({ active: true, currentWindow: true });
  const pattern = requiredCurrentSiteOriginPattern(
    args.state,
    typeof activeTab?.url === "string" ? activeTab.url : null,
  );
  if (!pattern) {
    return { required: false, pattern: null };
  }
  return {
    required: !(await hasWebsiteAccess(pattern)),
    pattern,
  };
}

function renderError(refs: PopupRefs, label: string): void {
  currentAction = null;
  refs.statusTitle.dataset.kind = "error";
  refs.statusTitle.textContent = label;
  refs.primaryAction.hidden = true;
  refs.primaryAction.disabled = false;
}

async function renderState(
  refs: PopupRefs,
  state: BackgroundState,
): Promise<void> {
  const [hasAllWebsiteAccess, currentSitePermission] = await Promise.all([
    hasAllUrlHostPermission(),
    resolveCurrentSitePermission({ state }),
  ]);
  currentSiteOriginPattern = currentSitePermission.pattern;
  const view = derivePopupStatusModel({
    state,
    hasAllWebsiteAccess,
    currentSitePermissionRequired: currentSitePermission.required,
  });
  currentAction = view.action?.kind ?? null;
  refs.statusTitle.dataset.kind = view.kind;
  refs.statusTitle.textContent = view.label;
  refs.primaryAction.hidden = view.action === null;
  refs.primaryAction.disabled = false;
  refs.primaryAction.textContent = view.action?.label ?? "";
  refs.disconnectButton.hidden = !view.showDisconnect;
  refs.details.hidden = !view.showDisconnect;
}

async function loadState(): Promise<BackgroundState | null> {
  const response = await sendMessage({ type: "browser-bridge:get-state" });
  if (!response.ok || !response.state) return null;
  return response.state;
}

async function refresh(refs: PopupRefs): Promise<void> {
  const loaded = await loadState();
  if (!loaded) {
    renderError(refs, "Couldn’t read the browser connection");
    return;
  }
  await renderState(refs, loaded);
}

async function runContextualAction(refs: PopupRefs): Promise<void> {
  const action = currentAction;
  if (!action) return;
  refs.primaryAction.disabled = true;
  refs.statusTitle.dataset.kind = "syncing";
  refs.statusTitle.textContent =
    action === "grant_website_access" || action === "grant_current_site"
      ? "Waiting for browser permission…"
      : "Connecting to Eliza…";

  if (action === "grant_website_access" || action === "grant_current_site") {
    try {
      const granted =
        action === "grant_website_access"
          ? await requestAllWebsiteAccess()
          : currentSiteOriginPattern !== null &&
            (await requestWebsiteAccess(currentSiteOriginPattern));
      if (!granted) {
        renderError(refs, "Website access wasn’t granted");
        currentAction = action;
        refs.primaryAction.textContent = "Try again";
        refs.primaryAction.hidden = false;
        return;
      }
    } catch {
      // error-policy:J4 Permission failure remains a visible recoverable state.
      renderError(refs, "Website access wasn’t granted");
      currentAction = action;
      refs.primaryAction.textContent = "Try again";
      refs.primaryAction.hidden = false;
      return;
    }
  }

  const response = await sendMessage({
    type:
      action === "recover"
        ? "browser-bridge:owner-reconnect"
        : "browser-bridge:sync-now",
  });
  if (!response.ok || !response.state) {
    renderError(refs, "Couldn’t connect to Eliza");
    currentAction = action;
    refs.primaryAction.textContent =
      action === "recover" ? "Reconnect" : "Try again";
    refs.primaryAction.hidden = false;
    return;
  }
  await renderState(refs, response.state);
}

document.addEventListener("DOMContentLoaded", () => {
  const refs = getPopupRefs();
  void refresh(refs);

  refs.primaryAction.addEventListener("click", () => {
    void runContextualAction(refs);
  });

  refs.disconnectButton.addEventListener("click", async () => {
    if (!globalThis.confirm("Disconnect this browser from Eliza?")) return;
    refs.disconnectButton.disabled = true;
    const response = await sendMessage({ type: "browser-bridge:clear-config" });
    refs.disconnectButton.disabled = false;
    if (!response.ok || !response.state) {
      renderError(refs, popupResponseError(response));
      return;
    }
    refs.details.open = false;
    await renderState(refs, response.state);
  });
});
