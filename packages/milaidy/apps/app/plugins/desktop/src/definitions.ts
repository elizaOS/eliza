import type { PluginListenerHandle } from "@capacitor/core";

export interface TrayMenuItemBase {
  id: string;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "radio";
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  icon?: string;
  accelerator?: string;
}

export interface TrayMenuItemWithSubmenu extends TrayMenuItemBase {
  submenu?: TrayMenuItem[];
}

export type TrayMenuItem = TrayMenuItemWithSubmenu;

export interface TrayOptions {
  icon: string;
  tooltip?: string;
  title?: string;
  menu?: TrayMenuItem[];
}

export interface TrayClickEvent {
  x: number;
  y: number;
  button: "left" | "right" | "middle";
  modifiers: {
    alt: boolean;
    shift: boolean;
    ctrl: boolean;
    meta: boolean;
  };
}

export interface TrayMenuClickEvent {
  itemId: string;
  checked?: boolean;
}

export interface GlobalShortcut {
  id: string;
  accelerator: string;
  enabled?: boolean;
}

export interface GlobalShortcutEvent {
  id: string;
  accelerator: string;
}

export interface AutoLaunchOptions {
  enabled: boolean;
  openAsHidden?: boolean;
  path?: string;
  args?: string[];
}

export interface WindowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  resizable?: boolean;
  movable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  closable?: boolean;
  focusable?: boolean;
  alwaysOnTop?: boolean;
  fullscreen?: boolean;
  fullscreenable?: boolean;
  skipTaskbar?: boolean;
  frame?: boolean;
  transparent?: boolean;
  opacity?: number;
  title?: string;
  vibrancy?: "appearance-based" | "light" | "dark" | "titlebar" | "selection" | "menu" | "popover" | "sidebar" | "header" | "sheet" | "window" | "hud" | "fullscreen-ui" | "tooltip" | "content" | "under-window" | "under-page";
  backgroundColor?: string;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NotificationOptions {
  title: string;
  body?: string;
  icon?: string;
  silent?: boolean;
  urgency?: "normal" | "critical" | "low";
  timeoutType?: "default" | "never";
  actions?: Array<{
    type: "button";
    text: string;
  }>;
  closeButtonText?: string;
  hasReply?: boolean;
  replyPlaceholder?: string;
}

export interface NotificationEvent {
  action?: string;
  reply?: string;
}

export interface PowerMonitorState {
  onBattery: boolean;
  batteryLevel?: number;
  isCharging?: boolean;
  idleState: "active" | "idle" | "locked" | "unknown";
  idleTime: number;
}

export interface DesktopPlugin {
  // System Tray
  createTray(options: TrayOptions): Promise<void>;
  updateTray(options: Partial<TrayOptions>): Promise<void>;
  destroyTray(): Promise<void>;
  setTrayMenu(options: { menu: TrayMenuItem[] }): Promise<void>;

  // Global Shortcuts
  registerShortcut(options: GlobalShortcut): Promise<{ success: boolean }>;
  unregisterShortcut(options: { id: string }): Promise<void>;
  unregisterAllShortcuts(): Promise<void>;
  isShortcutRegistered(options: { accelerator: string }): Promise<{ registered: boolean }>;

  // Auto Launch
  setAutoLaunch(options: AutoLaunchOptions): Promise<void>;
  getAutoLaunchStatus(): Promise<{ enabled: boolean; openAsHidden: boolean }>;

  // Window Management
  setWindowOptions(options: WindowOptions): Promise<void>;
  getWindowBounds(): Promise<WindowBounds>;
  setWindowBounds(options: WindowBounds): Promise<void>;
  minimizeWindow(): Promise<void>;
  maximizeWindow(): Promise<void>;
  unmaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  showWindow(): Promise<void>;
  hideWindow(): Promise<void>;
  focusWindow(): Promise<void>;
  isWindowMaximized(): Promise<{ maximized: boolean }>;
  isWindowMinimized(): Promise<{ minimized: boolean }>;
  isWindowVisible(): Promise<{ visible: boolean }>;
  isWindowFocused(): Promise<{ focused: boolean }>;
  setAlwaysOnTop(options: { flag: boolean; level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver" }): Promise<void>;
  setFullscreen(options: { flag: boolean }): Promise<void>;
  setOpacity(options: { opacity: number }): Promise<void>;

  // Notifications
  showNotification(options: NotificationOptions): Promise<{ id: string }>;
  closeNotification(options: { id: string }): Promise<void>;

  // Power Monitor
  getPowerState(): Promise<PowerMonitorState>;

  // App
  quit(): Promise<void>;
  relaunch(): Promise<void>;
  getVersion(): Promise<{ version: string; name: string; electron: string; chrome: string; node: string }>;
  isPackaged(): Promise<{ packaged: boolean }>;
  getPath(options: { name: "home" | "appData" | "userData" | "sessionData" | "temp" | "exe" | "module" | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos" | "recent" | "logs" | "crashDumps" }): Promise<{ path: string }>;

  // Clipboard
  writeToClipboard(options: { text?: string; html?: string; image?: string; rtf?: string }): Promise<void>;
  readFromClipboard(): Promise<{ text?: string; html?: string; rtf?: string; hasImage: boolean }>;
  clearClipboard(): Promise<void>;

  // Shell
  openExternal(options: { url: string }): Promise<void>;
  showItemInFolder(options: { path: string }): Promise<void>;
  beep(): Promise<void>;

  // Events
  addListener(eventName: "trayClick", listenerFunc: (event: TrayClickEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "trayDoubleClick", listenerFunc: (event: TrayClickEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "trayRightClick", listenerFunc: (event: TrayClickEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "trayMenuClick", listenerFunc: (event: TrayMenuClickEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "shortcutPressed", listenerFunc: (event: GlobalShortcutEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "notificationClick", listenerFunc: (event: NotificationEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "notificationAction", listenerFunc: (event: NotificationEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "notificationReply", listenerFunc: (event: NotificationEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "windowFocus", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "windowBlur", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "windowMaximize", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "windowUnmaximize", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "windowMinimize", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "windowRestore", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "windowClose", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "powerSuspend", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "powerResume", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "powerOnAC", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "powerOnBattery", listenerFunc: () => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
