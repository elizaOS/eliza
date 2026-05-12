type ComponentProps = Record<string, unknown>;

function NullComponent(_props: ComponentProps): null {
  return null;
}

export class ElizaClient {}

export const client = new ElizaClient();

export const Badge = NullComponent;
export const Button = NullComponent;
export const Input = NullComponent;
export const PagePanel = NullComponent;
export const PageScopedChatPane = NullComponent;
export const SegmentedControl = NullComponent;
export const Switch = NullComponent;
export const Textarea = NullComponent;
export const TooltipHint = NullComponent;

export function useApp(): Record<string, unknown> {
  return {};
}

export function useAppWorkspaceChatChrome(): Record<string, unknown> {
  return {};
}

export function useChatComposer(): Record<string, unknown> {
  return {};
}

export function dispatchFocusConnector(): void {}

export function isApiError(): boolean {
  return false;
}

export function openExternalUrl(): void {}

export function registerBuiltinWidgetDeclarations(): void {}

export function registerBuiltinWidgets(): void {}

export function getAppBlockerPlugin(): Record<string, unknown> {
  return {};
}
