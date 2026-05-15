export interface TrayRegistrationOptions {
  icon?: string;
  tooltip?: string;
  onClick?(): void;
}

export interface TrayHandle {
  dispose(): void;
  isAttached: boolean;
}

interface ElectrobunTrayApi {
  create(options: { icon?: string; tooltip?: string }): { id: string };
  on(event: "click", id: string, callback: () => void): void;
  destroy(id: string): void;
}

interface ElectrobunGlobal {
  tray?: ElectrobunTrayApi;
}

interface WindowWithElectrobun {
  electrobun?: ElectrobunGlobal;
}

function getElectrobun(): ElectrobunGlobal | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as unknown as WindowWithElectrobun).electrobun;
  return candidate ?? null;
}

const NULL_HANDLE: TrayHandle = {
  dispose: () => undefined,
  isAttached: false,
};

export function registerTrayIcon(
  options: TrayRegistrationOptions = {},
): TrayHandle {
  const electrobun = getElectrobun();
  const trayApi = electrobun?.tray;
  if (!trayApi) {
    return NULL_HANDLE;
  }

  const created = trayApi.create({
    icon: options.icon,
    tooltip: options.tooltip,
  });
  if (options.onClick) {
    trayApi.on("click", created.id, options.onClick);
  }

  let disposed = false;
  return {
    isAttached: true,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      trayApi.destroy(created.id);
    },
  };
}
