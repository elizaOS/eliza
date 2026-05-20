/**
 * Connection setup UI — mode picker rendered in app-xr onboarding.
 *
 * Presents three connection modes to the user:
 *   local  — agent is running on the LAN
 *   cloud  — agent is hosted on Eliza Cloud
 *   custom — user provides a WebSocket URL
 */

import type { ConnectionConfig, ConnectionMode } from "../connection-config.ts";
import { configToWsUrl, saveConfig } from "../connection-config.ts";

const MODE_LABELS: Record<ConnectionMode, string> = {
  local: "Local (LAN)",
  cloud: "Eliza Cloud",
  custom: "Custom URL",
};

const MODE_DESCRIPTIONS: Record<ConnectionMode, string> = {
  local: "Connect to an agent running on your home network or computer.",
  cloud: "Connect to a cloud-hosted agent via Eliza Cloud.",
  custom: "Provide your own WebSocket URL for advanced setups.",
};

/**
 * Render the mode-picker into the given container element and return
 * a promise that resolves with the chosen ConnectionConfig once the
 * user confirms.
 */
export function renderConnectionSetup(
  container: HTMLElement,
  initialConfig: ConnectionConfig,
  onConnect: (config: ConnectionConfig) => void,
): void {
  let current: ConnectionConfig = { ...initialConfig };

  function buildModeButton(mode: ConnectionMode): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = `mode-btn${current.mode === mode ? " active" : ""}`;
    btn.dataset.mode = mode;
    btn.innerHTML = `
      <strong>${MODE_LABELS[mode]}</strong>
      <span>${MODE_DESCRIPTIONS[mode]}</span>
    `;
    btn.addEventListener("click", () => {
      current = { ...current, mode };
      renderForm();
    });
    return btn;
  }

  function renderForm(): void {
    container.innerHTML = "";

    const title = document.createElement("h2");
    title.textContent = "Connect to Agent";
    container.appendChild(title);

    const modeRow = document.createElement("div");
    modeRow.className = "mode-row";
    for (const mode of ["local", "cloud", "custom"] as ConnectionMode[]) {
      modeRow.appendChild(buildModeButton(mode));
    }
    container.appendChild(modeRow);

    const fields = document.createElement("div");
    fields.className = "mode-fields";

    if (current.mode === "local") {
      fields.innerHTML = `
        <label>Host <input id="xr-host" type="text" value="${current.host ?? "localhost"}" /></label>
        <label>Port <input id="xr-port" type="number" value="${current.port ?? 31338}" /></label>
      `;
    } else if (current.mode === "cloud") {
      fields.innerHTML = `
        <label>App ID <input id="xr-appid" type="text" value="${current.appId ?? ""}" /></label>
      `;
    } else {
      fields.innerHTML = `
        <label>WebSocket URL <input id="xr-url" type="text" value="${current.customUrl ?? "ws://"}" /></label>
      `;
    }
    container.appendChild(fields);

    const connectBtn = document.createElement("button");
    connectBtn.className = "connect-btn";
    connectBtn.textContent = "Connect";
    connectBtn.addEventListener("click", () => {
      if (current.mode === "local") {
        current.host = (document.getElementById("xr-host") as HTMLInputElement)?.value ?? "localhost";
        current.port = Number((document.getElementById("xr-port") as HTMLInputElement)?.value ?? 31338);
      } else if (current.mode === "cloud") {
        current.appId = (document.getElementById("xr-appid") as HTMLInputElement)?.value;
      } else {
        current.customUrl = (document.getElementById("xr-url") as HTMLInputElement)?.value;
      }
      saveConfig(current);
      onConnect(current);
    });
    container.appendChild(connectBtn);

    const preview = document.createElement("div");
    preview.className = "url-preview";
    try {
      preview.textContent = `WebSocket: ${configToWsUrl(current)}`;
    } catch {
      preview.textContent = "Enter connection details above";
    }
    container.appendChild(preview);
  }

  renderForm();
}
