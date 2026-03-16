interface ElectrobunBrowserWindow extends Window {
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
}

function getRuntimeWindow(): ElectrobunBrowserWindow | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window as ElectrobunBrowserWindow;
}

export function isElectrobunRuntime(): boolean {
  const runtimeWindow = getRuntimeWindow();
  if (!runtimeWindow) {
    return false;
  }

  return (
    typeof runtimeWindow.__electrobunWindowId === "number" ||
    typeof runtimeWindow.__electrobunWebviewId === "number"
  );
}

export function getBackendStartupTimeoutMs(): number {
  return isElectrobunRuntime() ? 180_000 : 30_000;
}
