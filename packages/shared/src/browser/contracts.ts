export const BROWSER_BRIDGE_KINDS = ["chrome", "safari"] as const;
export type BrowserBridgeKind = (typeof BROWSER_BRIDGE_KINDS)[number];

export const BROWSER_BRIDGE_ACTION_KINDS = [
  "open",
  "navigate",
  "focus_tab",
  "back",
  "forward",
  "reload",
  "click",
  "type",
  "submit",
  "read_page",
  "extract_links",
  "extract_forms",
] as const;
export type BrowserBridgeActionKind =
  (typeof BROWSER_BRIDGE_ACTION_KINDS)[number];

export interface BrowserBridgeAction {
  id: string;
  kind: BrowserBridgeActionKind;
  label: string;
  browser?: BrowserBridgeKind | null;
  windowId?: string | null;
  tabId?: string | null;
  url: string | null;
  selector: string | null;
  text: string | null;
  accountAffecting: boolean;
  requiresConfirmation: boolean;
  metadata: Record<string, unknown>;
}
