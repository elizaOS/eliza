// Renders the branded, guided entry point for every elizaOS install path.
import { useMemo, useState } from "react";
import { HttpAospFlasherBackend } from "../backend/http-backend";
import { FlasherApp } from "./FlasherApp";
import { IosFlasher } from "./IosFlasher";

type TabId = "usb" | "android" | "ios";

interface Tab {
  id: TabId;
  title: string;
  description: string;
}

const TABS: Tab[] = [
  {
    id: "usb",
    title: "Computer",
    description: "Bootable USB",
  },
  {
    id: "android",
    title: "Android",
    description: "Supported Pixel",
  },
  {
    id: "ios",
    title: "iPhone & iPad",
    description: "Eliza app",
  },
];

const USB_INSTALLER_DEV_URL = "http://127.0.0.1:3742";
const USB_INSTALLER_DOWNLOAD_URL = "https://elizaos.ai/downloads#usb-installer";

interface OpenItemShell {
  openExternal?: (url: string) => unknown;
  openItem?: (path: string) => unknown;
}

interface ElectrobunWindowGlobal {
  electrobun?: { shell?: OpenItemShell };
}

function openExternal(url: string): void {
  const w = window as ElectrobunWindowGlobal;
  const shell = w.electrobun?.shell;
  if (shell?.openExternal) {
    shell.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function tryLaunchPackagedUsbInstaller(): boolean {
  const w = window as ElectrobunWindowGlobal;
  const shell = w.electrobun?.shell;
  if (!shell?.openItem) return false;
  try {
    shell.openItem("/Applications/elizaOS USB Installer.app");
    return true;
  } catch {
    return false;
  }
}

function isDev(): boolean {
  try {
    const meta = import.meta as { env?: { DEV?: boolean } };
    return meta.env?.DEV === true;
  } catch {
    return false;
  }
}

function handleOpenUsbInstaller(): void {
  if (isDev()) {
    openExternal(USB_INSTALLER_DEV_URL);
    return;
  }
  if (tryLaunchPackagedUsbInstaller()) return;
  openExternal(USB_INSTALLER_DOWNLOAD_URL);
}

function UsbInstallerPanel() {
  return (
    <div className="install-panel-content usb-panel">
      <div className="install-panel-copy">
        <h2>Set up a computer</h2>
        <p className="panel-lede">
          Create a bootable USB drive for a desktop or laptop. The installer
          downloads and verifies the right elizaOS image for you.
        </p>
        <div className="safety-note" role="note">
          <strong>Your drive is not changed automatically.</strong>
          <span>
            You will review the exact drive before anything is erased.
          </span>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="brand-button"
            onClick={handleOpenUsbInstaller}
          >
            Open USB Installer
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => openExternal(USB_INSTALLER_DOWNLOAD_URL)}
          >
            Download it instead
          </button>
        </div>
      </div>

      <div className="requirements">
        <h3>What you need</h3>
        <ol className="how-it-works" aria-label="What you need for USB setup">
          <li>
            <div>
              <strong>A spare USB drive</strong>
              <p>16 GB or larger. Its contents will be erased.</p>
            </div>
          </li>
          <li>
            <div>
              <strong>The computer you are setting up</strong>
              <p>You will choose its hardware type in the next app.</p>
            </div>
          </li>
          <li>
            <div>
              <strong>About 15 minutes</strong>
              <p>Download time depends on your connection.</p>
            </div>
          </li>
        </ol>
      </div>
    </div>
  );
}

export interface InstallerShellProps {
  serverUrl: string;
}

export function InstallerShell({ serverUrl }: InstallerShellProps) {
  const [activeTab, setActiveTab] = useState<TabId>("usb");
  const backend = useMemo(
    () => new HttpAospFlasherBackend(serverUrl),
    [serverUrl],
  );

  return (
    <div className="installer-shell">
      <header className="installer-topbar">
        <div className="installer-brand">
          <img
            className="installer-logo"
            src="./brand/logos/eliza_logotext.svg"
            alt="Eliza"
          />
          <span className="brand-divider" aria-hidden />
          <span className="setup-label">Installer</span>
        </div>
        <button
          type="button"
          className="header-help"
          onClick={() => openExternal("https://docs.elizaos.ai")}
        >
          Help
        </button>
      </header>

      <main className="installer-main">
        <section className="installer-intro">
          <h1>Install elizaOS</h1>
          <p>Choose where you want to use it.</p>
        </section>

        <nav className="install-tabs" aria-label="Choose a device">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                className={`install-tab${isActive ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                aria-pressed={isActive}
              >
                <strong>{tab.title}</strong>
                <span>{tab.description}</span>
              </button>
            );
          })}
        </nav>

        <section className={`installer-workspace workspace-${activeTab}`}>
          {activeTab === "usb" && <UsbInstallerPanel />}
          {activeTab === "android" && <FlasherApp backend={backend} embedded />}
          {activeTab === "ios" && <IosFlasher serverUrl={serverUrl} />}
        </section>

        <footer className="installer-footer">
          You can close the installer at any time before confirming a change.
        </footer>
      </main>
    </div>
  );
}
