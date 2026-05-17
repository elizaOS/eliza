export const ELIZA_GENUI_PRIMITIVE_COMPONENTS = [
  "Row",
  "Column",
  "List",
  "Text",
  "Image",
  "Icon",
  "Divider",
  "Button",
  "TextField",
  "CheckBox",
  "Slider",
  "DateTimeInput",
  "ChoicePicker",
  "Card",
  "Modal",
  "Tabs",
] as const;

export const ELIZA_GENUI_DOMAIN_COMPONENTS = [
  "ProviderSetupCard",
  "ModelPicker",
  "ConnectorSetupCard",
  "PermissionRequest",
  "StarterPackStatus",
  "LaunchDiagnosticsCard",
  "TraceTimeline",
  "VoiceLatencyTimeline",
  "ToolCallTimeline",
  "GitDiffViewer",
  "TerminalTranscript",
  "FileSearchResults",
  "ModelDownloadStatus",
] as const;

export const ELIZA_GENUI_ALLOWED_COMPONENTS = [
  ...ELIZA_GENUI_PRIMITIVE_COMPONENTS,
  ...ELIZA_GENUI_DOMAIN_COMPONENTS,
] as const;

export type ElizaGenUiPrimitiveComponent =
  (typeof ELIZA_GENUI_PRIMITIVE_COMPONENTS)[number];

export type ElizaGenUiDomainComponent =
  (typeof ELIZA_GENUI_DOMAIN_COMPONENTS)[number];

export type ElizaGenUiKnownComponent =
  (typeof ELIZA_GENUI_ALLOWED_COMPONENTS)[number];

export const ELIZA_GENUI_ALLOWED_ACTION_PREFIXES = [
  "setup.",
  "model.",
  "provider.",
  "connector.",
  "runtime.",
  "capability.",
  "dynamicView.",
  "trace.",
  "voice.",
] as const;

export function isElizaGenUiKnownComponent(
  value: string,
): value is ElizaGenUiKnownComponent {
  return (ELIZA_GENUI_ALLOWED_COMPONENTS as readonly string[]).includes(value);
}

export function isElizaGenUiPrimitiveComponent(
  value: string,
): value is ElizaGenUiPrimitiveComponent {
  return (ELIZA_GENUI_PRIMITIVE_COMPONENTS as readonly string[]).includes(
    value,
  );
}

export function isElizaGenUiActionNameAllowed(
  eventName: string,
  prefixes: readonly string[] = ELIZA_GENUI_ALLOWED_ACTION_PREFIXES,
  names: readonly string[] = [],
): boolean {
  return (
    names.includes(eventName) ||
    prefixes.some((prefix) => eventName.startsWith(prefix))
  );
}
