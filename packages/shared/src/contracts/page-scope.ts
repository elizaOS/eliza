export type PageScope =
  | "page-browser"
  | "page-character"
  | "page-automations"
  | "page-apps"
  | "page-connectors"
  | "page-phone"
  | "page-plugins"
  | "page-settings"
  | "page-wallet";

export const PAGE_SCOPES: readonly PageScope[] = [
  "page-browser",
  "page-character",
  "page-automations",
  "page-apps",
  "page-connectors",
  "page-phone",
  "page-plugins",
  "page-settings",
  "page-wallet",
] as const;

const PAGE_SCOPE_SET = new Set<string>(PAGE_SCOPES);

export function isPageScope(value: unknown): value is PageScope {
  return typeof value === "string" && PAGE_SCOPE_SET.has(value);
}
