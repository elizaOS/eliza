type WebviewTagElement = HTMLElement & {
  loadURL(url: string): void;
  reload(): void;
  executeJavascript(js: string): void;
  on(event: "host-message", handler: (event: CustomEvent) => void): void;
  off(event: "host-message", handler: (event: CustomEvent) => void): void;
  /**
   * Synchronizes the OOPIF's frame with the anchor's `getBoundingClientRect()`.
   * The tag auto-syncs on its own resize, but layout changes outside the
   * element (sidebar collapse, window resize, parent flex reflow) need a
   * manual poke. `force: true` triggers the sync even if dimensions look
   * unchanged.
   */
  syncDimensions(force?: boolean): void;
  /**
   * Hide/show the underlying native OOPIF view. The HTML `hidden` attribute
   * does not propagate to the native layer — only this method does. Without
   * it, inactive tabs' OOPIFs stay painted over the surface and intercept
   * clicks meant for sibling UI.
   */
  toggleHidden(value?: boolean): void;
  /**
   * Toggle pointer-event passthrough on the native OOPIF view. When enabled
   * the surface stops capturing clicks even if it remains visible, so React
   * siblings stacked over the same rect (overlays mid-transition, the
   * inactive-tab opacity-0 layer) can receive events. Used alongside
   * `toggleHidden` on inactive tabs so the native view neither paints nor
   * grabs input during the gap between layout flap and first sync.
   */
  togglePassthrough(value?: boolean): void;
};
type ElectrobunWebviewProps = React.DetailedHTMLProps<
  React.HTMLAttributes<WebviewTagElement> & {
    src?: string;
    partition?: string;
    preload?: string;
    sandbox?: boolean | "";
    transparent?: boolean | "";
    hidden?: boolean;
    /**
     * "cef" (bundled Chromium) or "native" (system WKWebView on macOS).
     * Set explicitly per-tag rather than relying on the
     * `defaultRenderer` config: CEF is what supports the OOPIF model
     * + RPC + preload script the agent automation kit depends on.
     */
    renderer?: "cef" | "native";
    /**
     * Comma-separated CSS selectors. Any element matching is treated
     * as a punch-out rect — the native OOPIF will not paint over it
     * and will not capture clicks within it. Required so React
     * overlays (modals, dropdowns, toasts) render above the webview
     * surface and remain interactive.
     */
    masks?: string;
    /**
     * Initial passthrough state. When present the OOPIF starts in
     * pointer-events: none mode. Set on inactive tabs so the gap
     * between mount and the first selection effect doesn't leak
     * clicks into the wrong tab.
     */
    passthrough?: boolean | "";
  },
  WebviewTagElement
>;
declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": ElectrobunWebviewProps;
    }
  }
}
export declare function BrowserWorkspaceView(): React.JSX.Element;
//# sourceMappingURL=BrowserWorkspaceView.d.ts.map
