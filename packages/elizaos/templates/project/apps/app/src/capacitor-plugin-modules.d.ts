declare module "@elizaos/capacitor-agent" {
  export const Agent: {
    getStatus(): Promise<{ status: string }>;
  };
}

declare module "@elizaos/capacitor-camera" {
  export {};
}

declare module "@elizaos/capacitor-canvas" {
  export {};
}

declare module "@elizaos/capacitor-desktop" {
  type DesktopEventPayload<TEvent extends string> =
    TEvent extends "shortcutPressed"
      ? { id: string }
      : TEvent extends "trayMenuClick"
        ? { itemId: string; checked?: boolean }
        : unknown;

  export const Desktop: {
    getVersion(): Promise<{ runtime: string }>;
    registerShortcut(options: {
      id: string;
      accelerator: string;
    }): Promise<void>;
    addListener<TEvent extends string>(
      eventName: TEvent,
      listener: (event: DesktopEventPayload<TEvent>) => void,
    ): Promise<{ remove(): void | Promise<void> }>;
    setTrayMenu(options: { menu: readonly unknown[] }): Promise<void>;
  };
}

declare module "@elizaos/capacitor-gateway" {
  export {};
}

declare module "@elizaos/capacitor-location" {
  export {};
}

declare module "@elizaos/capacitor-mobile-signals" {
  export {};
}

declare module "@elizaos/capacitor-screencapture" {
  export {};
}

declare module "@elizaos/capacitor-swabble" {
  export {};
}

declare module "@elizaos/capacitor-talkmode" {
  export {};
}

declare module "@elizaos/capacitor-websiteblocker" {
  export {};
}

declare module "@elizaos/signal-native";
declare module "qrcode";
