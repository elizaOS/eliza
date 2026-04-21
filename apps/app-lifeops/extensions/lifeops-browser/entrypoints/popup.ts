import { derivePopupStatusModel } from "../src/popup-model";
import type {
  BackgroundState,
  CompanionConfig,
  PopupRequest,
  PopupResponse,
} from "../src/protocol";
import {
  discoverLifeOpsApiBaseUrl,
  LEGACY_LIFEOPS_API_BASE_URL,
} from "../src/storage";
import { sendRuntimeMessage } from "../src/webextension";

type FormRefs = {
  apiBaseUrl: HTMLInputElement;
  autoPairButton: HTMLButtonElement;
  browser: HTMLSelectElement;
  companionId: HTMLInputElement;
  pairingToken: HTMLInputElement;
  profileId: HTMLInputElement;
  profileLabel: HTMLInputElement;
  label: HTMLInputElement;
  pairingJson: HTMLTextAreaElement;
  statusBadge: HTMLElement;
  statusTitle: HTMLElement;
  statusDetail: HTMLElement;
  statusChecklist: HTMLUListElement;
  summary: HTMLElement;
  saveButton: HTMLButtonElement;
  importButton: HTMLButtonElement;
  syncButton: HTMLButtonElement;
  clearButton: HTMLButtonElement;
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

function getFormRefs(): FormRefs {
  return {
    apiBaseUrl: requireElement("#apiBaseUrl", HTMLInputElement),
    autoPairButton: requireElement("#autoPair", HTMLButtonElement),
    browser: requireElement("#browser", HTMLSelectElement),
    companionId: requireElement("#companionId", HTMLInputElement),
    pairingToken: requireElement("#pairingToken", HTMLInputElement),
    profileId: requireElement("#profileId", HTMLInputElement),
    profileLabel: requireElement("#profileLabel", HTMLInputElement),
    label: requireElement("#label", HTMLInputElement),
    pairingJson: requireElement("#pairingJson", HTMLTextAreaElement),
    statusBadge: requireElement("#statusBadge", HTMLElement),
    statusTitle: requireElement("#statusTitle", HTMLElement),
    statusDetail: requireElement("#statusDetail", HTMLElement),
    statusChecklist: requireElement("#statusChecklist", HTMLUListElement),
    summary: requireElement("#summary", HTMLElement),
    saveButton: requireElement("#save", HTMLButtonElement),
    importButton: requireElement("#import", HTMLButtonElement),
    syncButton: requireElement("#sync", HTMLButtonElement),
    clearButton: requireElement("#clear", HTMLButtonElement),
  };
}

let autoPairAttempted = false;

function renderChecklist(
  listElement: HTMLUListElement,
  entries: string[],
): void {
  listElement.innerHTML = "";
  for (const entry of entries) {
    const item = document.createElement("li");
    item.textContent = entry;
    listElement.appendChild(item);
  }
}

function renderSummary(refs: FormRefs, entries: string[]): void {
  refs.summary.replaceChildren();
  for (const entry of entries) {
    const pill = document.createElement("span");
    pill.className = "summary-pill";
    pill.textContent = entry;
    refs.summary.appendChild(pill);
  }
}

function renderState(
  refs: FormRefs,
  state: BackgroundState,
  discoveredApiBaseUrl: string | null,
): void {
  const config = state.config;
  refs.apiBaseUrl.value = config?.apiBaseUrl ?? LEGACY_LIFEOPS_API_BASE_URL;
  refs.browser.value = config?.browser ?? "chrome";
  refs.companionId.value = config?.companionId ?? "";
  refs.pairingToken.value = config?.pairingToken ?? "";
  refs.profileId.value = config?.profileId ?? "default";
  refs.profileLabel.value = config?.profileLabel ?? "default";
  refs.label.value = config?.label ?? "";
  const model = derivePopupStatusModel({
    state,
    discoveredApiBaseUrl,
  });
  refs.statusBadge.textContent = model.badge;
  refs.statusBadge.dataset.kind = model.kind;
  refs.statusTitle.textContent = model.title;
  refs.statusDetail.textContent = model.detail;
  renderChecklist(refs.statusChecklist, model.checklist);
  renderSummary(
    refs,
    state.activeSessionId
      ? [...model.summary, `Session: ${state.activeSessionId}`]
      : model.summary,
  );
  refs.autoPairButton.textContent = model.primaryLabel;
  refs.autoPairButton.disabled = state.syncing;
  refs.syncButton.hidden = !model.showSync || model.primaryAction === "sync";
  refs.syncButton.disabled = state.syncing;
}

async function applyDiscoveredApiBaseUrl(
  refs: FormRefs,
  state: BackgroundState,
): Promise<void> {
  const configured = state.config?.apiBaseUrl?.trim() ?? "";
  if (
    configured.length > 0 &&
    configured.replace(/\/+$/, "") !== LEGACY_LIFEOPS_API_BASE_URL
  ) {
    return;
  }
  const discovered = await discoverLifeOpsApiBaseUrl();
  if (!discovered) {
    return;
  }
  refs.apiBaseUrl.value = discovered;
}

async function sendMessage<T extends PopupRequest>(
  request: T,
): Promise<PopupResponse> {
  return await sendRuntimeMessage<PopupResponse>(request);
}

function readConfig(refs: FormRefs): Partial<CompanionConfig> {
  return {
    apiBaseUrl: refs.apiBaseUrl.value,
    browser: refs.browser.value === "safari" ? "safari" : "chrome",
    companionId: refs.companionId.value,
    pairingToken: refs.pairingToken.value,
    profileId: refs.profileId.value,
    profileLabel: refs.profileLabel.value,
    label: refs.label.value,
  };
}

function parsePairingJson(jsonValue: string): Partial<CompanionConfig> {
  const trimmed = jsonValue.trim();
  if (!trimmed) {
    throw new Error("Paste the pairing JSON before importing it");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Pairing JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pairing JSON must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  return {
    apiBaseUrl:
      typeof record.apiBaseUrl === "string" ? record.apiBaseUrl : undefined,
    browser: record.browser === "safari" ? "safari" : "chrome",
    companionId:
      typeof record.companionId === "string" ? record.companionId : "",
    pairingToken:
      typeof record.pairingToken === "string" ? record.pairingToken : "",
    profileId: typeof record.profileId === "string" ? record.profileId : "",
    profileLabel:
      typeof record.profileLabel === "string" ? record.profileLabel : "",
    label: typeof record.label === "string" ? record.label : "",
  };
}

async function refresh(refs: FormRefs): Promise<void> {
  const response = await sendMessage({ type: "lifeops-browser:get-state" });
  if (!response.ok || !response.state) {
    refs.statusTitle.textContent = "LifeOps Browser could not load";
    refs.statusDetail.textContent = response.error;
    return;
  }
  const discoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
  renderState(refs, response.state, discoveredApiBaseUrl);
  if (discoveredApiBaseUrl) {
    refs.apiBaseUrl.value = discoveredApiBaseUrl;
  } else {
    await applyDiscoveredApiBaseUrl(refs, response.state);
  }
  if (!response.state.config && !autoPairAttempted) {
    autoPairAttempted = true;
    refs.statusTitle.textContent = "Looking for LifeOps in this browser";
    refs.statusDetail.textContent =
      "Searching open tabs for a live LifeOps app so this browser can connect itself.";
    const autoPairResponse = await sendMessage({
      type: "lifeops-browser:auto-pair",
    });
    if (autoPairResponse.ok && autoPairResponse.state) {
      const nextDiscoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
      renderState(refs, autoPairResponse.state, nextDiscoveredApiBaseUrl);
      if (nextDiscoveredApiBaseUrl) {
        refs.apiBaseUrl.value = nextDiscoveredApiBaseUrl;
      } else {
        await applyDiscoveredApiBaseUrl(refs, autoPairResponse.state);
      }
      return;
    }
    if (!autoPairResponse.ok) {
      refs.statusDetail.textContent = autoPairResponse.error;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const refs = getFormRefs();

  void refresh(refs);

  refs.autoPairButton.addEventListener("click", async () => {
    const currentResponse = await sendMessage({
      type: "lifeops-browser:get-state",
    });
    const currentState = currentResponse.ok ? currentResponse.state : null;
    const discoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
    const model = currentState
      ? derivePopupStatusModel({
          state: currentState,
          discoveredApiBaseUrl,
        })
      : null;
    refs.statusDetail.textContent =
      model?.primaryAction === "sync"
        ? "Syncing this browser with LifeOps…"
        : "Trying to auto-connect this browser…";
    autoPairAttempted = true;
    const response =
      model?.primaryAction === "sync"
        ? await sendMessage({ type: "lifeops-browser:sync-now" })
        : await sendMessage({
            type: "lifeops-browser:auto-pair",
          });
    if (!response.ok || !response.state) {
      refs.statusDetail.textContent = response.error;
      return;
    }
    const nextDiscoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
    renderState(refs, response.state, nextDiscoveredApiBaseUrl);
    if (nextDiscoveredApiBaseUrl) {
      refs.apiBaseUrl.value = nextDiscoveredApiBaseUrl;
    } else {
      await applyDiscoveredApiBaseUrl(refs, response.state);
    }
  });

  refs.saveButton.addEventListener("click", async () => {
    refs.statusDetail.textContent = "Saving manual pairing…";
    const response = await sendMessage({
      type: "lifeops-browser:save-config",
      config: readConfig(refs),
    });
    if (!response.ok || !response.state) {
      refs.statusDetail.textContent = response.error;
      return;
    }
    autoPairAttempted = true;
    const discoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
    renderState(refs, response.state, discoveredApiBaseUrl);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });

  refs.importButton.addEventListener("click", async () => {
    refs.statusDetail.textContent = "Importing manual pairing JSON…";
    let config: Partial<CompanionConfig>;
    try {
      config = parsePairingJson(refs.pairingJson.value);
    } catch (error) {
      refs.statusDetail.textContent =
        error instanceof Error ? error.message : String(error);
      return;
    }
    const response = await sendMessage({
      type: "lifeops-browser:save-config",
      config,
    });
    if (!response.ok || !response.state) {
      refs.statusDetail.textContent = response.error;
      return;
    }
    refs.pairingJson.value = "";
    autoPairAttempted = true;
    const discoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
    renderState(refs, response.state, discoveredApiBaseUrl);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });

  refs.syncButton.addEventListener("click", async () => {
    refs.statusDetail.textContent = "Syncing this browser with LifeOps…";
    const response = await sendMessage({ type: "lifeops-browser:sync-now" });
    if (!response.ok || !response.state) {
      refs.statusDetail.textContent = response.error;
      return;
    }
    const discoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
    renderState(refs, response.state, discoveredApiBaseUrl);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });

  refs.clearButton.addEventListener("click", async () => {
    const response = await sendMessage({
      type: "lifeops-browser:clear-config",
    });
    if (!response.ok || !response.state) {
      refs.statusDetail.textContent = response.error;
      return;
    }
    autoPairAttempted = false;
    const discoveredApiBaseUrl = await discoverLifeOpsApiBaseUrl();
    renderState(refs, response.state, discoveredApiBaseUrl);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });
});
