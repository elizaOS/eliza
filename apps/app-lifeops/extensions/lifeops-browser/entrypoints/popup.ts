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
  browser: HTMLSelectElement;
  companionId: HTMLInputElement;
  pairingToken: HTMLInputElement;
  profileId: HTMLInputElement;
  profileLabel: HTMLInputElement;
  label: HTMLInputElement;
  pairingJson: HTMLTextAreaElement;
  status: HTMLElement;
  meta: HTMLElement;
  saveButton: HTMLButtonElement;
  importButton: HTMLButtonElement;
  syncButton: HTMLButtonElement;
  clearButton: HTMLButtonElement;
};

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element ${selector}`);
  }
  return element as T;
}

function getFormRefs(): FormRefs {
  return {
    apiBaseUrl: requireElement<HTMLInputElement>("#apiBaseUrl"),
    browser: requireElement<HTMLSelectElement>("#browser"),
    companionId: requireElement<HTMLInputElement>("#companionId"),
    pairingToken: requireElement<HTMLInputElement>("#pairingToken"),
    profileId: requireElement<HTMLInputElement>("#profileId"),
    profileLabel: requireElement<HTMLInputElement>("#profileLabel"),
    label: requireElement<HTMLInputElement>("#label"),
    pairingJson: requireElement<HTMLTextAreaElement>("#pairingJson"),
    status: requireElement<HTMLElement>("#status"),
    meta: requireElement<HTMLElement>("#meta"),
    saveButton: requireElement<HTMLButtonElement>("#save"),
    importButton: requireElement<HTMLButtonElement>("#import"),
    syncButton: requireElement<HTMLButtonElement>("#sync"),
    clearButton: requireElement<HTMLButtonElement>("#clear"),
  };
}

function renderState(refs: FormRefs, state: BackgroundState): void {
  const config = state.config;
  refs.apiBaseUrl.value = config?.apiBaseUrl ?? LEGACY_LIFEOPS_API_BASE_URL;
  refs.browser.value = config?.browser ?? "chrome";
  refs.companionId.value = config?.companionId ?? "";
  refs.pairingToken.value = config?.pairingToken ?? "";
  refs.profileId.value = config?.profileId ?? "default";
  refs.profileLabel.value = config?.profileLabel ?? "default";
  refs.label.value = config?.label ?? "";
  refs.status.textContent =
    state.lastError ??
    state.lastSessionStatus ??
    (state.lastSyncAt
      ? `Synced ${new Date(state.lastSyncAt).toLocaleTimeString()}`
      : "Not synced yet");
  refs.meta.textContent = [
    `Remembered tabs: ${state.rememberedTabCount}`,
    state.settingsSummary ? `Settings: ${state.settingsSummary}` : null,
    state.activeSessionId ? `Session: ${state.activeSessionId}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
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
    refs.status.textContent = response.error;
    return;
  }
  renderState(refs, response.state);
  await applyDiscoveredApiBaseUrl(refs, response.state);
}

document.addEventListener("DOMContentLoaded", () => {
  const refs = getFormRefs();

  void refresh(refs);

  refs.saveButton.addEventListener("click", async () => {
    refs.status.textContent = "Saving companion pairing...";
    const response = await sendMessage({
      type: "lifeops-browser:save-config",
      config: readConfig(refs),
    });
    if (!response.ok || !response.state) {
      refs.status.textContent = response.error;
      return;
    }
    renderState(refs, response.state);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });

  refs.importButton.addEventListener("click", async () => {
    refs.status.textContent = "Importing pairing JSON...";
    let config: Partial<CompanionConfig>;
    try {
      config = parsePairingJson(refs.pairingJson.value);
    } catch (error) {
      refs.status.textContent =
        error instanceof Error ? error.message : String(error);
      return;
    }
    const response = await sendMessage({
      type: "lifeops-browser:save-config",
      config,
    });
    if (!response.ok || !response.state) {
      refs.status.textContent = response.error;
      return;
    }
    refs.pairingJson.value = "";
    renderState(refs, response.state);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });

  refs.syncButton.addEventListener("click", async () => {
    refs.status.textContent = "Syncing...";
    const response = await sendMessage({ type: "lifeops-browser:sync-now" });
    if (!response.ok || !response.state) {
      refs.status.textContent = response.error;
      return;
    }
    renderState(refs, response.state);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });

  refs.clearButton.addEventListener("click", async () => {
    const response = await sendMessage({
      type: "lifeops-browser:clear-config",
    });
    if (!response.ok || !response.state) {
      refs.status.textContent = response.error;
      return;
    }
    renderState(refs, response.state);
    await applyDiscoveredApiBaseUrl(refs, response.state);
  });
});
