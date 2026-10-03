/**
 * Test stub for `@elizaos/ui`: minimal stand-ins for the app-shell primitives
 * the phone components import (Button, Input, host detection, agent-surface,
 * page/app registration, navigate-view payload) so component tests run without
 * the real UI package and can seed a navigate-view payload.
 */

import React from "react";

export type OverlayAppContext = Record<string, unknown>;
export type OverlayApp = Record<string, unknown>;

interface StubButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: string;
  size?: string;
  shape?: string;
  align?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, StubButtonProps>(
  function Button(
    {
      align: _align,
      children,
      shape: _shape,
      size: _size,
      variant: _variant,
      ...props
    },
    ref,
  ) {
    return React.createElement(
      "button",
      { ...props, ref, type: props.type ?? "button" },
      children,
    );
  },
);

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input(props, ref) {
  return React.createElement("input", { ...props, ref });
});

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
