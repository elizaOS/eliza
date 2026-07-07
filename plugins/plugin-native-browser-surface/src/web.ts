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
  CreateSurfaceOptions,
  ElizaSurfaceManagerPlugin,
  NavigateOptions,
  SetBoundsOptions,
  SurfaceIdOptions,
  SurfaceState,
} from "./definitions";

const UNAVAILABLE =
  "ElizaSurfaceManager is a native-only plugin: a web host has no native child web surface.";

export class BrowserSurfaceWeb
  extends WebPlugin
  implements ElizaSurfaceManagerPlugin
{
  async createSurface(_options: CreateSurfaceOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async setBounds(_options: SetBoundsOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async navigate(_options: NavigateOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async foregroundSurface(_options: SurfaceIdOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async backgroundSurface(_options: SurfaceIdOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async destroySurface(_options: SurfaceIdOptions): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async foregroundHost(): Promise<void> {
    throw this.unavailable(UNAVAILABLE);
  }
  async getSurfaceState(_options: SurfaceIdOptions): Promise<SurfaceState> {
    throw this.unavailable(UNAVAILABLE);
  }
}
