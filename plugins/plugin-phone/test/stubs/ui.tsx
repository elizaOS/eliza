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

// Cross-view phone-number handoff (mirrors @elizaos/ui/app-navigate-view). The
// phone view consumes a pending number on mount; the tests drive the dialer
// directly, so the stub simply returns null (no pending handoff).
export function consumePendingPhoneNumber(): string | null {
  return null;
}

export function consumePendingMessageRecipient(): string | null {
  return null;
}

export function navigateToPhoneWithNumber(): void {}

export function navigateToMessagesWithNumber(): void {}
