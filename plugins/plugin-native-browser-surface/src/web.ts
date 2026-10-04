/**
 * Web fallback for the surface manager: every method rejects as unsupported. A
 * web host renders the Browser view's tabs as sandboxed iframes, never as native
 * child surfaces, so the renderer never selects the `native-mobile-webview` path
 * there and never calls this plugin. Rejecting (rather than silently succeeding)
 * makes an accidental call a loud failure instead of a surface that appears to
 * exist but isolates nothing.
 */
import { WebPlugin } from "@capacitor/core";

import type {
  BrowserDockState,
  CreateSurfaceOptions,
  ElizaSurfaceManagerPlugin,
  NativePageRead,
  NavigateOptions,
  PresentSurfaceOptions,
  ReconcileOwnerOptions,
  SetBoundsOptions,
  SetOcclusionRectsOptions,
  SurfaceIdOptions,
  SurfaceOwnerOptions,
  SurfaceState,
  SurfaceStateList,
} from "./definitions";

const UNAVAILABLE =
  "ElizaSurfaceManager is a native-only plugin: a web host has no native child web surface.";

export class BrowserSurfaceWeb
  extends WebPlugin
  implements ElizaSurfaceManagerPlugin
{
  async getBrowserHelperEntryState(): Promise<{
    permissionGranted: boolean;
    visible: boolean;
    fullScreen: boolean;
  }> {
    throw this.unavailable(UNAVAILABLE);
  }
  async requestBrowserHelperEntryPermission(): Promise<{
    status: "dispatched";
  }> {
    throw this.unavailable(UNAVAILABLE);
  }
  async hideBrowserDockWithEntry(_options: {
    label: string;
    description: string;
  }): Promise<{ status: "requested" }> {
    throw this.unavailable(UNAVAILABLE);
  }
  async restoreBrowserDockFromEntry(): Promise<{ status: "requested" }> {
    throw this.unavailable(UNAVAILABLE);
  }
  async setBrowserDockVisible(_options: {
    visible: boolean;
  }): Promise<{ status: "requested" }> {
    throw this.unavailable(UNAVAILABLE);
  }

  async openDockedBrowser(_options: {
    url: string;
    panelWidthDp?: number;
  }): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
    status: "dispatched";
  }> {
    throw this.unavailable(UNAVAILABLE);
  }
  async getBrowserDockState(): Promise<BrowserDockState> {
    throw this.unavailable(UNAVAILABLE);
  }
  async presentBrowser(): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
  }> {
    throw this.unavailable(UNAVAILABLE);
  }

  async openBrowser(_options: { url: string }): Promise<{
    packageName: "org.chromium.chrome" | "ai.elizaos.chromium";
    engine: "chromium";
    surface: "custom-tab";
  }> {
    throw this.unavailable(UNAVAILABLE);
  }

  async createSurface(_options: CreateSurfaceOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async setBounds(_options: SetBoundsOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async setOcclusionRects(_options: SetOcclusionRectsOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async navigate(_options: NavigateOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async reloadSurface(_options: SurfaceIdOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async goBack(_options: SurfaceIdOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async readPage(
    _options: SurfaceIdOptions & { selector?: string },
  ): Promise<NativePageRead> {
    throw this.unavailable(UNAVAILABLE);
  }
  async presentSurface(_options: PresentSurfaceOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async destroySurface(_options: SurfaceIdOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async getSurfaceState(_options: SurfaceIdOptions): Promise<SurfaceState> {
    throw this.unavailable(UNAVAILABLE);
  }
  async listSurfaceStates(
    _options: SurfaceOwnerOptions,
  ): Promise<SurfaceStateList> {
    throw this.unavailable(UNAVAILABLE);
  }
  async reconcileOwner(_options: ReconcileOwnerOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
}
