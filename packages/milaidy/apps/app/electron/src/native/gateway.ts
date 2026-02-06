/**
 * Gateway Native Module for Electron
 *
 * Provides native mDNS/Bonjour discovery for local gateway servers
 * and DNS-SD for wide-area discovery.
 */

import { EventEmitter } from "events";
import { ipcMain } from "electron";
import { BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcValue } from "./ipc-types";

// Types
export interface GatewayEndpoint {
  stableId: string;
  name: string;
  host: string;
  port: number;
  lanHost?: string;
  tailnetDns?: string;
  gatewayPort?: number;
  canvasPort?: number;
  tlsEnabled: boolean;
  tlsFingerprintSha256?: string;
  isLocal: boolean;
}

export interface DiscoveryOptions {
  serviceType?: string;
  timeout?: number;
  includeTxt?: boolean;
  wideAreaDomain?: string;
}

// Try to load mDNS/Bonjour module dynamically
interface MDNSService {
  name?: string;
  host?: string;
  port?: number;
  txtRecord?: Record<string, string>;
  addresses?: string[];
}

interface MDNSBrowser {
  on(event: "serviceUp" | "serviceDown", callback: (service: MDNSService) => void): void;
  start(): void;
  stop(): void;
}

interface MDNSModule {
  createBrowser(type: { name: string; protocol: string }): MDNSBrowser;
}

interface BonjourService {
  name: string;
  host: string;
  port: number;
  txt?: Record<string, string>;
  addresses?: string[];
}

interface BonjourBrowser {
  on(event: string, callback: (service: BonjourService) => void): void;
  stop(): void;
}

interface BonjourModule {
  find(options: { type: string }): BonjourBrowser;
}

let mdnsModule: MDNSModule | null = null;
type BonjourFactory = () => BonjourModule;
type BonjourModuleProvider = BonjourFactory | { default: BonjourFactory };
let bonjourModule: BonjourModuleProvider | null = null;

async function loadDiscoveryModule(): Promise<"mdns" | "bonjour" | null> {
  // Try mdns first (faster, native)
  try {
    const mod = (await import("mdns")) as { default?: MDNSModule } & Partial<MDNSModule>;
    mdnsModule = mod.default ?? (mod as MDNSModule);
    console.log("[Gateway] Loaded mdns module");
    return "mdns";
  } catch {
    // Continue
  }

  // Try bonjour (pure JS, more portable)
  try {
    bonjourModule = (await import("bonjour-service")) as BonjourModuleProvider;
    console.log("[Gateway] Loaded bonjour-service module");
    return "bonjour";
  } catch {
    // Continue
  }

  // Try alternative packages
  const alternatives = ["bonjour", "mdns-js"];
  for (const pkg of alternatives) {
    try {
      bonjourModule = (await import(pkg)) as BonjourModuleProvider;
      console.log(`[Gateway] Loaded ${pkg} module`);
      return "bonjour";
    } catch {
      // Continue
    }
  }

  console.warn("[Gateway] No mDNS/Bonjour module available. Install bonjour-service for local discovery.");
  return null;
}

/**
 * Gateway Discovery Manager
 */
export class GatewayDiscovery extends EventEmitter {
  private discoveredGateways: Map<string, GatewayEndpoint> = new Map();
  private browser: MDNSBrowser | BonjourBrowser | null = null;
  private discoveryType: "mdns" | "bonjour" | null = null;
  private isDiscovering = false;
  private serviceType = "_milaidy._tcp";
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    super();
  }

  /**
   * Set the main window for sending events
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Start gateway discovery
   */
  async startDiscovery(options?: DiscoveryOptions): Promise<{
    gateways: GatewayEndpoint[];
    status: string;
  }> {
    if (this.isDiscovering) {
      return {
        gateways: Array.from(this.discoveredGateways.values()),
        status: "Already discovering",
      };
    }

    // Load discovery module if not already loaded
    if (!this.discoveryType) {
      this.discoveryType = await loadDiscoveryModule();
    }

    if (!this.discoveryType) {
      return {
        gateways: [],
        status: "Discovery unavailable (no mDNS module)",
      };
    }

    const serviceType = options?.serviceType || this.serviceType;
    this.discoveredGateways.clear();
    this.isDiscovering = true;

    try {
      if (this.discoveryType === "mdns" && mdnsModule) {
        await this.startMDNSDiscovery(serviceType);
      } else if (bonjourModule) {
        await this.startBonjourDiscovery(serviceType);
      }

      this.emit("started");

      // Set timeout if specified
      if (options?.timeout) {
        setTimeout(() => {
          this.stopDiscovery();
        }, options.timeout);
      }

      return {
        gateways: Array.from(this.discoveredGateways.values()),
        status: "Discovery started",
      };
    } catch (error) {
      this.isDiscovering = false;
      const message = error instanceof Error ? error.message : "Discovery failed";
      return {
        gateways: [],
        status: message,
      };
    }
  }

  private async startMDNSDiscovery(serviceType: string): Promise<void> {
    if (!mdnsModule) return;

    const [name, protocol] = serviceType.replace(/^_/, "").split("._");
    this.browser = mdnsModule.createBrowser({
      name: name,
      protocol: protocol || "tcp",
    });

    this.browser.on("serviceUp", (service: MDNSService) => {
      this.handleServiceFound({
        name: service.name || "Unknown",
        host: service.host || "localhost",
        port: service.port || 8080,
        txt: service.txtRecord,
        addresses: service.addresses,
      });
    });

    this.browser.on("serviceDown", (service: MDNSService) => {
      this.handleServiceLost({
        name: service.name,
        host: service.host,
        port: service.port,
      });
    });

    // Start the browser to begin discovery
    (this.browser as MDNSBrowser).start();
  }

  private async startBonjourDiscovery(serviceType: string): Promise<void> {
    if (!bonjourModule) return;

    const factory = typeof bonjourModule === "function" ? bonjourModule : bonjourModule.default;
    if (!factory) return;
    const bonjour = factory();
    const type = serviceType.replace(/^_/, "").replace(/\._tcp$/, "");

    this.browser = bonjour.find({ type }) as BonjourBrowser;

    this.browser.on("up", (service: BonjourService) => {
      this.handleServiceFound(service);
    });

    this.browser.on("down", (service: BonjourService) => {
      this.handleServiceLost(service.name);
    });
  }

  private handleServiceFound(service: BonjourService): void {
    const txt = service.txt ?? {};
    const stableId = txt.id ?? `${service.name}-${service.host}:${service.port}`;
    const tlsEnabled = txt.protocol === "wss" || this.parseBoolean(txt.tlsEnabled ?? txt.tls);
    const gatewayPort = this.parseNumber(txt.gatewayPort) ?? service.port;
    const canvasPort = this.parseNumber(txt.canvasPort);

    const endpoint: GatewayEndpoint = {
      stableId,
      name: service.name,
      host: service.addresses?.[0] ?? service.host,
      port: service.port,
      lanHost: service.host,
      tailnetDns: txt.tailnetDns,
      gatewayPort,
      canvasPort,
      tlsEnabled,
      tlsFingerprintSha256: txt.tlsFingerprintSha256,
      isLocal: true,
    };

    const isUpdate = this.discoveredGateways.has(stableId);
    this.discoveredGateways.set(stableId, endpoint);
    this.emit(isUpdate ? "updated" : "discovered", endpoint);
    this.sendToRenderer("gateway:discovery", {
      type: isUpdate ? "updated" : "found",
      gateway: endpoint,
    });
  }

  private handleServiceLost(service: { name?: string; host?: string; port?: number }): void {
    for (const [id, gateway] of this.discoveredGateways) {
      const nameMatch = service.name && gateway.name === service.name;
      const hostMatch = service.host && (gateway.host === service.host || gateway.lanHost === service.host);
      const portMatch = service.port && (gateway.port === service.port || gateway.gatewayPort === service.port);
      if (nameMatch || hostMatch || portMatch) {
        this.discoveredGateways.delete(id);
        this.emit("lost", gateway);
        this.sendToRenderer("gateway:discovery", {
          type: "lost",
          gateway,
        });
        break;
      }
    }
  }

  /**
   * Stop gateway discovery
   */
  async stopDiscovery(): Promise<void> {
    if (!this.isDiscovering) return;

    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }

    this.isDiscovering = false;
    this.emit("stopped");
  }

  /**
   * Get all discovered gateways
   */
  getDiscoveredGateways(): GatewayEndpoint[] {
    return Array.from(this.discoveredGateways.values());
  }

  /**
   * Check if discovery is active
   */
  isDiscoveryActive(): boolean {
    return this.isDiscovering;
  }

  private sendToRenderer(channel: string, data: IpcValue): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  private parseBoolean(value: string | boolean | undefined): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      return value === "true" || value === "1" || value === "yes";
    }
    return false;
  }

  private parseNumber(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stopDiscovery();
    this.discoveredGateways.clear();
    this.removeAllListeners();
  }
}

// Singleton instance
let gatewayDiscovery: GatewayDiscovery | null = null;

export function getGatewayDiscovery(): GatewayDiscovery {
  if (!gatewayDiscovery) {
    gatewayDiscovery = new GatewayDiscovery();
  }
  return gatewayDiscovery;
}

/**
 * Register Gateway IPC handlers
 */
export function registerGatewayIPC(): void {
  const discovery = getGatewayDiscovery();

  ipcMain.handle("gateway:startDiscovery", async (_e: IpcMainInvokeEvent, options?: DiscoveryOptions) => {
    return discovery.startDiscovery(options);
  });

  ipcMain.handle("gateway:stopDiscovery", async () => {
    return discovery.stopDiscovery();
  });

  ipcMain.handle("gateway:getDiscoveredGateways", () => {
    return {
      gateways: discovery.getDiscoveredGateways(),
    };
  });

  ipcMain.handle("gateway:isDiscovering", () => {
    return { isDiscovering: discovery.isDiscoveryActive() };
  });
}
