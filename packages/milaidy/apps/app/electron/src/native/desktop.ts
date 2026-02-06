/**
 * Desktop Native Module for Electron
 *
 * Provides native desktop features:
 * - System tray management
 * - Global keyboard shortcuts
 * - Auto-launch on startup
 * - Window management
 * - Native notifications
 * - Power monitoring
 * - Clipboard operations
 * - Shell operations
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  Notification,
  powerMonitor,
  clipboard,
  shell,
  nativeImage,
  ipcMain,
  MenuItemConstructorOptions,
} from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "path";
import fs from "fs";
import type { IpcValue } from "./ipc-types";

// Types
interface TrayMenuItem {
  id: string;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "radio";
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  icon?: string;
  accelerator?: string;
  submenu?: TrayMenuItem[];
}

interface TrayOptions {
  icon: string;
  tooltip?: string;
  title?: string;
  menu?: TrayMenuItem[];
}

interface GlobalShortcut {
  id: string;
  accelerator: string;
  enabled?: boolean;
}

interface NotificationOptions {
  title: string;
  body?: string;
  icon?: string;
  silent?: boolean;
  urgency?: "normal" | "critical" | "low";
  timeoutType?: "default" | "never";
  actions?: Array<{ type: "button"; text: string }>;
  closeButtonText?: string;
  hasReply?: boolean;
  replyPlaceholder?: string;
}

interface WindowOptions {
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
  vibrancy?: string;
  backgroundColor?: string;
}

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SetAlwaysOnTopOptions {
  flag: boolean;
  level?: string;
}

interface SetFullscreenOptions {
  flag: boolean;
}

interface SetOpacityOptions {
  opacity: number;
}

interface ClipboardWriteOptions {
  text?: string;
  html?: string;
  image?: string;
  rtf?: string;
}

interface OpenExternalOptions {
  url: string;
}

interface ShowItemInFolderOptions {
  path: string;
}

/**
 * Desktop Manager - handles all native desktop features
 */
export class DesktopManager {
  private mainWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private shortcuts: Map<string, GlobalShortcut> = new Map();
  private notifications: Map<string, Notification> = new Map();
  private notificationCounter = 0;

  constructor() {
    this.setupPowerMonitorEvents();
  }

  /**
   * Set the main window reference
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
    this.setupWindowEvents();
  }

  private getWindow(): BrowserWindow {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      throw new Error("Main window not available");
    }
    return this.mainWindow;
  }

  // MARK: - System Tray

  async createTray(options: TrayOptions): Promise<void> {
    if (this.tray) {
      this.tray.destroy();
    }

    const iconPath = this.resolveIconPath(options.icon);
    const icon = nativeImage.createFromPath(iconPath);

    this.tray = new Tray(icon);

    if (options.tooltip) {
      this.tray.setToolTip(options.tooltip);
    }

    if (options.title && process.platform === "darwin") {
      this.tray.setTitle(options.title);
    }

    if (options.menu) {
      this.setTrayMenu({ menu: options.menu });
    }

    this.setupTrayEvents();
  }

  async updateTray(options: Partial<TrayOptions>): Promise<void> {
    if (!this.tray) return;

    if (options.icon) {
      const iconPath = this.resolveIconPath(options.icon);
      const icon = nativeImage.createFromPath(iconPath);
      this.tray.setImage(icon);
    }

    if (options.tooltip) {
      this.tray.setToolTip(options.tooltip);
    }

    if (options.title !== undefined && process.platform === "darwin") {
      this.tray.setTitle(options.title);
    }

    if (options.menu) {
      this.setTrayMenu({ menu: options.menu });
    }
  }

  async destroyTray(): Promise<void> {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  setTrayMenu(options: { menu: TrayMenuItem[] }): void {
    if (!this.tray) return;

    const template = this.buildMenuTemplate(options.menu);
    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
  }

  private buildMenuTemplate(items: TrayMenuItem[]): MenuItemConstructorOptions[] {
    return items.map((item): MenuItemConstructorOptions => {
      const menuItem: MenuItemConstructorOptions = {
        id: item.id,
        label: item.label,
        type: item.type,
        checked: item.checked,
        enabled: item.enabled !== false,
        visible: item.visible !== false,
        accelerator: item.accelerator,
        click: () => {
          this.sendToRenderer("desktop:trayMenuClick", {
            itemId: item.id,
            checked: item.type === "checkbox" ? !item.checked : item.checked,
          });
        },
      };

      if (item.icon) {
        const iconPath = this.resolveIconPath(item.icon);
        if (fs.existsSync(iconPath)) {
          menuItem.icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
        }
      }

      if (item.submenu) {
        menuItem.submenu = this.buildMenuTemplate(item.submenu);
      }

      return menuItem;
    });
  }

  private setupTrayEvents(): void {
    if (!this.tray) return;

    this.tray.on("click", (event, bounds) => {
      this.sendToRenderer("desktop:trayClick", {
        x: bounds.x,
        y: bounds.y,
        button: "left",
        modifiers: {
          alt: event.altKey,
          shift: event.shiftKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
        },
      });
    });

    this.tray.on("double-click", (event, bounds) => {
      this.sendToRenderer("desktop:trayDoubleClick", {
        x: bounds.x,
        y: bounds.y,
        button: "left",
        modifiers: {
          alt: event.altKey,
          shift: event.shiftKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
        },
      });
    });

    this.tray.on("right-click", (event, bounds) => {
      this.sendToRenderer("desktop:trayRightClick", {
        x: bounds.x,
        y: bounds.y,
        button: "right",
        modifiers: {
          alt: event.altKey,
          shift: event.shiftKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
        },
      });
    });
  }

  // MARK: - Global Shortcuts

  async registerShortcut(options: GlobalShortcut): Promise<{ success: boolean }> {
    if (this.shortcuts.has(options.id)) {
      globalShortcut.unregister(this.shortcuts.get(options.id)!.accelerator);
    }

    const success = globalShortcut.register(options.accelerator, () => {
      this.sendToRenderer("desktop:shortcutPressed", {
        id: options.id,
        accelerator: options.accelerator,
      });
    });

    if (success) {
      this.shortcuts.set(options.id, options);
    }

    return { success };
  }

  async unregisterShortcut(options: { id: string }): Promise<void> {
    const shortcut = this.shortcuts.get(options.id);
    if (shortcut) {
      globalShortcut.unregister(shortcut.accelerator);
      this.shortcuts.delete(options.id);
    }
  }

  async unregisterAllShortcuts(): Promise<void> {
    globalShortcut.unregisterAll();
    this.shortcuts.clear();
  }

  async isShortcutRegistered(options: { accelerator: string }): Promise<{ registered: boolean }> {
    return { registered: globalShortcut.isRegistered(options.accelerator) };
  }

  // MARK: - Auto Launch

  async setAutoLaunch(options: { enabled: boolean; openAsHidden?: boolean }): Promise<void> {
    app.setLoginItemSettings({
      openAtLogin: options.enabled,
      openAsHidden: options.openAsHidden,
    });
  }

  async getAutoLaunchStatus(): Promise<{ enabled: boolean; openAsHidden: boolean }> {
    const settings = app.getLoginItemSettings();
    return {
      enabled: settings.openAtLogin,
      openAsHidden: settings.openAsHidden || false,
    };
  }

  // MARK: - Window Management

  async setWindowOptions(options: WindowOptions): Promise<void> {
    const win = this.getWindow();

    if (options.width !== undefined || options.height !== undefined) {
      const bounds = win.getBounds();
      win.setSize(options.width ?? bounds.width, options.height ?? bounds.height);
    }

    if (options.x !== undefined || options.y !== undefined) {
      const bounds = win.getBounds();
      win.setPosition(options.x ?? bounds.x, options.y ?? bounds.y);
    }

    if (options.minWidth !== undefined || options.minHeight !== undefined) {
      win.setMinimumSize(options.minWidth ?? 0, options.minHeight ?? 0);
    }

    if (options.maxWidth !== undefined || options.maxHeight !== undefined) {
      win.setMaximumSize(options.maxWidth ?? 0, options.maxHeight ?? 0);
    }

    if (options.resizable !== undefined) win.setResizable(options.resizable);
    if (options.movable !== undefined) win.setMovable(options.movable);
    if (options.minimizable !== undefined) win.setMinimizable(options.minimizable);
    if (options.maximizable !== undefined) win.setMaximizable(options.maximizable);
    if (options.closable !== undefined) win.setClosable(options.closable);
    if (options.focusable !== undefined) win.setFocusable(options.focusable);
    if (options.alwaysOnTop !== undefined) win.setAlwaysOnTop(options.alwaysOnTop);
    if (options.fullscreen !== undefined) win.setFullScreen(options.fullscreen);
    if (options.fullscreenable !== undefined) win.setFullScreenable(options.fullscreenable);
    if (options.skipTaskbar !== undefined) win.setSkipTaskbar(options.skipTaskbar);
    if (options.opacity !== undefined) win.setOpacity(options.opacity);
    if (options.title !== undefined) win.setTitle(options.title);
    if (options.backgroundColor !== undefined) win.setBackgroundColor(options.backgroundColor);
    if (options.vibrancy !== undefined && process.platform === "darwin") {
      win.setVibrancy(options.vibrancy as Parameters<typeof win.setVibrancy>[0]);
    }
  }

  async getWindowBounds(): Promise<WindowBounds> {
    return this.getWindow().getBounds();
  }

  async setWindowBounds(options: WindowBounds): Promise<void> {
    this.getWindow().setBounds(options);
  }

  async minimizeWindow(): Promise<void> {
    this.getWindow().minimize();
  }

  async maximizeWindow(): Promise<void> {
    this.getWindow().maximize();
  }

  async unmaximizeWindow(): Promise<void> {
    this.getWindow().unmaximize();
  }

  async closeWindow(): Promise<void> {
    this.getWindow().close();
  }

  async showWindow(): Promise<void> {
    this.getWindow().show();
  }

  async hideWindow(): Promise<void> {
    this.getWindow().hide();
  }

  async focusWindow(): Promise<void> {
    this.getWindow().focus();
  }

  async isWindowMaximized(): Promise<{ maximized: boolean }> {
    return { maximized: this.getWindow().isMaximized() };
  }

  async isWindowMinimized(): Promise<{ minimized: boolean }> {
    return { minimized: this.getWindow().isMinimized() };
  }

  async isWindowVisible(): Promise<{ visible: boolean }> {
    return { visible: this.getWindow().isVisible() };
  }

  async isWindowFocused(): Promise<{ focused: boolean }> {
    return { focused: this.getWindow().isFocused() };
  }

  async setAlwaysOnTop(options: SetAlwaysOnTopOptions): Promise<void> {
    this.getWindow().setAlwaysOnTop(
      options.flag,
      options.level as Parameters<BrowserWindow["setAlwaysOnTop"]>[1]
    );
  }

  async setFullscreen(options: SetFullscreenOptions): Promise<void> {
    this.getWindow().setFullScreen(options.flag);
  }

  async setOpacity(options: SetOpacityOptions): Promise<void> {
    this.getWindow().setOpacity(options.opacity);
  }

  private setupWindowEvents(): void {
    if (!this.mainWindow) return;

    this.mainWindow.on("focus", () => this.sendToRenderer("desktop:windowFocus"));
    this.mainWindow.on("blur", () => this.sendToRenderer("desktop:windowBlur"));
    this.mainWindow.on("maximize", () => this.sendToRenderer("desktop:windowMaximize"));
    this.mainWindow.on("unmaximize", () => this.sendToRenderer("desktop:windowUnmaximize"));
    this.mainWindow.on("minimize", () => this.sendToRenderer("desktop:windowMinimize"));
    this.mainWindow.on("restore", () => this.sendToRenderer("desktop:windowRestore"));
    this.mainWindow.on("close", () => this.sendToRenderer("desktop:windowClose"));
  }

  // MARK: - Notifications

  async showNotification(options: NotificationOptions): Promise<{ id: string }> {
    const id = `notification_${++this.notificationCounter}`;

    const notification = new Notification({
      title: options.title,
      body: options.body,
      icon: options.icon ? this.resolveIconPath(options.icon) : undefined,
      silent: options.silent,
      urgency: options.urgency,
      timeoutType: options.timeoutType,
      actions: options.actions,
      closeButtonText: options.closeButtonText,
      hasReply: options.hasReply,
      replyPlaceholder: options.replyPlaceholder,
    });

    notification.on("click", () => {
      this.sendToRenderer("desktop:notificationClick", { id });
    });

    notification.on("action", (_event, index) => {
      this.sendToRenderer("desktop:notificationAction", {
        id,
        action: options.actions?.[index]?.text,
      });
    });

    notification.on("reply", (_event, reply) => {
      this.sendToRenderer("desktop:notificationReply", { id, reply });
    });

    notification.on("close", () => {
      this.notifications.delete(id);
    });

    this.notifications.set(id, notification);
    notification.show();

    return { id };
  }

  async closeNotification(options: { id: string }): Promise<void> {
    const notification = this.notifications.get(options.id);
    if (notification) {
      notification.close();
      this.notifications.delete(options.id);
    }
  }

  // MARK: - Power Monitor

  async getPowerState(): Promise<{
    onBattery: boolean;
    batteryLevel?: number;
    isCharging?: boolean;
    idleState: "active" | "idle" | "locked" | "unknown";
    idleTime: number;
  }> {
    const idleTime = powerMonitor.getSystemIdleTime();
    const idleState = powerMonitor.getSystemIdleState(60) as "active" | "idle" | "locked" | "unknown";

    // Note: Battery info not available on all platforms
    let onBattery = false;
    try {
      onBattery = powerMonitor.isOnBatteryPower();
    } catch {
      // Not supported
    }

    return {
      onBattery,
      idleState,
      idleTime,
    };
  }

  private setupPowerMonitorEvents(): void {
    powerMonitor.on("suspend", () => this.sendToRenderer("desktop:powerSuspend"));
    powerMonitor.on("resume", () => this.sendToRenderer("desktop:powerResume"));
    powerMonitor.on("on-ac", () => this.sendToRenderer("desktop:powerOnAC"));
    powerMonitor.on("on-battery", () => this.sendToRenderer("desktop:powerOnBattery"));
  }

  // MARK: - App

  async quit(): Promise<void> {
    app.quit();
  }

  async relaunch(): Promise<void> {
    app.relaunch();
    app.exit(0);
  }

  async getVersion(): Promise<{
    version: string;
    name: string;
    electron: string;
    chrome: string;
    node: string;
  }> {
    return {
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    };
  }

  async isPackaged(): Promise<{ packaged: boolean }> {
    return { packaged: app.isPackaged };
  }

  async getPath(options: { name: string }): Promise<{ path: string }> {
    return { path: app.getPath(options.name as Parameters<typeof app.getPath>[0]) };
  }

  // MARK: - Clipboard

  async writeToClipboard(options: ClipboardWriteOptions): Promise<void> {
    if (options.text) {
      clipboard.writeText(options.text);
    } else if (options.html) {
      clipboard.writeHTML(options.html);
    } else if (options.rtf) {
      clipboard.writeRTF(options.rtf);
    } else if (options.image) {
      const img = nativeImage.createFromDataURL(options.image);
      clipboard.writeImage(img);
    }
  }

  async readFromClipboard(): Promise<{
    text?: string;
    html?: string;
    rtf?: string;
    hasImage: boolean;
  }> {
    return {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      hasImage: !clipboard.readImage().isEmpty(),
    };
  }

  async clearClipboard(): Promise<void> {
    clipboard.clear();
  }

  // MARK: - Shell

  async openExternal(options: OpenExternalOptions): Promise<void> {
    await shell.openExternal(options.url);
  }

  async showItemInFolder(options: ShowItemInFolderOptions): Promise<void> {
    shell.showItemInFolder(options.path);
  }

  async beep(): Promise<void> {
    shell.beep();
  }

  // MARK: - Helpers

  private resolveIconPath(iconPath: string): string {
    if (path.isAbsolute(iconPath)) {
      return iconPath;
    }

    // Try relative to app resources
    const resourcePath = path.join(app.getAppPath(), iconPath);
    if (fs.existsSync(resourcePath)) {
      return resourcePath;
    }

    // Try relative to electron assets
    const assetsPath = path.join(app.getAppPath(), "assets", iconPath);
    if (fs.existsSync(assetsPath)) {
      return assetsPath;
    }

    return iconPath;
  }

  private sendToRenderer(channel: string, data?: IpcValue): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.unregisterAllShortcuts();
    this.destroyTray();
    for (const notification of this.notifications.values()) {
      notification.close();
    }
    this.notifications.clear();
  }
}

// Singleton instance
let desktopManager: DesktopManager | null = null;

export function getDesktopManager(): DesktopManager {
  if (!desktopManager) {
    desktopManager = new DesktopManager();
  }
  return desktopManager;
}

/**
 * Register all Desktop IPC handlers
 */
export function registerDesktopIPC(): void {
  const manager = getDesktopManager();

  // Tray
  ipcMain.handle("desktop:createTray", (_e: IpcMainInvokeEvent, options: TrayOptions) => manager.createTray(options));
  ipcMain.handle("desktop:updateTray", (_e: IpcMainInvokeEvent, options: Partial<TrayOptions>) => manager.updateTray(options));
  ipcMain.handle("desktop:destroyTray", () => manager.destroyTray());
  ipcMain.handle("desktop:setTrayMenu", (_e: IpcMainInvokeEvent, options: { menu: TrayMenuItem[] }) => manager.setTrayMenu(options));

  // Shortcuts
  ipcMain.handle("desktop:registerShortcut", (_e: IpcMainInvokeEvent, options: GlobalShortcut) => manager.registerShortcut(options));
  ipcMain.handle("desktop:unregisterShortcut", (_e: IpcMainInvokeEvent, options: { id: string }) => manager.unregisterShortcut(options));
  ipcMain.handle("desktop:unregisterAllShortcuts", () => manager.unregisterAllShortcuts());
  ipcMain.handle("desktop:isShortcutRegistered", (_e: IpcMainInvokeEvent, options: { accelerator: string }) => manager.isShortcutRegistered(options));

  // Auto Launch
  ipcMain.handle("desktop:setAutoLaunch", (_e: IpcMainInvokeEvent, options: { enabled: boolean; openAsHidden?: boolean }) => manager.setAutoLaunch(options));
  ipcMain.handle("desktop:getAutoLaunchStatus", () => manager.getAutoLaunchStatus());

  // Window
  ipcMain.handle("desktop:setWindowOptions", (_e: IpcMainInvokeEvent, options: WindowOptions) => manager.setWindowOptions(options));
  ipcMain.handle("desktop:getWindowBounds", () => manager.getWindowBounds());
  ipcMain.handle("desktop:setWindowBounds", (_e: IpcMainInvokeEvent, options: WindowBounds) => manager.setWindowBounds(options));
  ipcMain.handle("desktop:minimizeWindow", () => manager.minimizeWindow());
  ipcMain.handle("desktop:maximizeWindow", () => manager.maximizeWindow());
  ipcMain.handle("desktop:unmaximizeWindow", () => manager.unmaximizeWindow());
  ipcMain.handle("desktop:closeWindow", () => manager.closeWindow());
  ipcMain.handle("desktop:showWindow", () => manager.showWindow());
  ipcMain.handle("desktop:hideWindow", () => manager.hideWindow());
  ipcMain.handle("desktop:focusWindow", () => manager.focusWindow());
  ipcMain.handle("desktop:isWindowMaximized", () => manager.isWindowMaximized());
  ipcMain.handle("desktop:isWindowMinimized", () => manager.isWindowMinimized());
  ipcMain.handle("desktop:isWindowVisible", () => manager.isWindowVisible());
  ipcMain.handle("desktop:isWindowFocused", () => manager.isWindowFocused());
  ipcMain.handle("desktop:setAlwaysOnTop", (_e: IpcMainInvokeEvent, options: SetAlwaysOnTopOptions) => manager.setAlwaysOnTop(options));
  ipcMain.handle("desktop:setFullscreen", (_e: IpcMainInvokeEvent, options: SetFullscreenOptions) => manager.setFullscreen(options));
  ipcMain.handle("desktop:setOpacity", (_e: IpcMainInvokeEvent, options: SetOpacityOptions) => manager.setOpacity(options));

  // Notifications
  ipcMain.handle("desktop:showNotification", (_e: IpcMainInvokeEvent, options: NotificationOptions) => manager.showNotification(options));
  ipcMain.handle("desktop:closeNotification", (_e: IpcMainInvokeEvent, options: { id: string }) => manager.closeNotification(options));

  // Power
  ipcMain.handle("desktop:getPowerState", () => manager.getPowerState());

  // App
  ipcMain.handle("desktop:quit", () => manager.quit());
  ipcMain.handle("desktop:relaunch", () => manager.relaunch());
  ipcMain.handle("desktop:getVersion", () => manager.getVersion());
  ipcMain.handle("desktop:isPackaged", () => manager.isPackaged());
  ipcMain.handle("desktop:getPath", (_e: IpcMainInvokeEvent, options: { name: string }) => manager.getPath(options));

  // Clipboard
  ipcMain.handle("desktop:writeToClipboard", (_e: IpcMainInvokeEvent, options: ClipboardWriteOptions) => manager.writeToClipboard(options));
  ipcMain.handle("desktop:readFromClipboard", () => manager.readFromClipboard());
  ipcMain.handle("desktop:clearClipboard", () => manager.clearClipboard());

  // Shell
  ipcMain.handle("desktop:openExternal", (_e: IpcMainInvokeEvent, options: OpenExternalOptions) => manager.openExternal(options));
  ipcMain.handle("desktop:showItemInFolder", (_e: IpcMainInvokeEvent, options: ShowItemInFolderOptions) => manager.showItemInFolder(options));
  ipcMain.handle("desktop:beep", () => manager.beep());
}
