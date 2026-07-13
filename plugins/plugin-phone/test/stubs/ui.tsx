/**
 * Test stub for `@elizaos/ui`: minimal stand-ins for the app-shell primitives
 * the phone components import (Button, host detection, agent-surface, page/app
 * registration, navigate-view payload) so component tests run without the real
 * UI package and can seed a navigate-view payload.
 */

import React from "react";

export type OverlayAppContext = Record<string, unknown>;
export type OverlayApp = Record<string, unknown>;

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(function Button({ children, ...props }, ref) {
  return React.createElement(
    "button",
    { ...props, ref, type: props.type ?? "button" },
    children,
  );
});

export function SettingsGroup({
  title,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { title?: React.ReactNode }) {
  return React.createElement(
    "section",
    props,
    title ? React.createElement("h3", null, title) : null,
    children,
  );
}

export function SettingsRow({
  label,
  description,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ComponentType<Record<string, unknown>>;
}) {
  return React.createElement(
    "div",
    null,
    React.createElement("span", null, label),
    description ? React.createElement("span", null, description) : null,
  );
}

export function isElizaOS(): boolean {
  return false;
}

export function useAgentElement<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  agentProps: Record<string, never>;
} {
  return {
    ref: React.createRef<T>(),
    agentProps: {},
  };
}

export function registerOverlayApp(): void {}

export function registerAppShellPage(): void {}

const pendingNavigateViewPayloads = new Map<string, unknown>();

export function __setNavigateViewPayloadForTests(
  viewId: string,
  payload: unknown,
): void {
  pendingNavigateViewPayloads.set(viewId, payload);
}

export function consumeNavigateViewPayload(viewId: string): unknown | null {
  if (!pendingNavigateViewPayloads.has(viewId)) return null;
  const payload = pendingNavigateViewPayloads.get(viewId);
  pendingNavigateViewPayloads.delete(viewId);
  return payload;
}
