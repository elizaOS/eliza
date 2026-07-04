/**
 * Test stub for @elizaos/ui: null and passthrough React components plus an empty
 * ElizaClient, so LifeOps component tests can import the UI surface without its real
 * implementation.
 */
import { createElement, Fragment, type ReactNode } from "react";

type ComponentProps = Record<string, unknown>;

function NullComponent(_props: ComponentProps): null {
  return null;
}

function PassthroughComponent(props: { children?: ReactNode }): ReactNode {
  return createElement(Fragment, null, props.children);
}

export class ElizaClient {}

export const client = new ElizaClient();

export const Badge = NullComponent;
export const Button = NullComponent;
export const Input = NullComponent;
export const PagePanel = NullComponent;
export const SegmentedControl = NullComponent;
export const Switch = NullComponent;
export const Textarea = NullComponent;
export const TooltipHint = PassthroughComponent;
export const TooltipProvider = PassthroughComponent;

export function useAgentElement(): Record<string, unknown> {
  return { ref: { current: null }, agentProps: {} };
}

export function useApp(): Record<string, unknown> {
  return {};
}

export function useChatComposer(): Record<string, unknown> {
  return {};
}

export function dispatchFocusConnector(): void {}

export function isApiError(): boolean {
  return false;
}

export function isElizaOS(): boolean {
  return false;
}

export function openExternalUrl(): void {}

export function registerBuiltinWidgetDeclarations(): void {}

export function registerBuiltinWidgets(): void {}

export function registerAppShellPage(): void {}

export function registerOverlayApp(): void {}

export function getAppBlockerPlugin(): Record<string, unknown> {
  return {};
}
