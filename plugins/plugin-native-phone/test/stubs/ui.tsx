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

export {
  __setNavigateViewPayloadForTests,
  consumeNavigateViewPayload,
} from "../../../../packages/ui/src/app-navigate-view.ts";
export { dispatchNavigateViewEvent } from "../../../../packages/ui/src/events/index.ts";
export {
  Button as SpatialButton,
  Card as SpatialCard,
  Divider as SpatialDivider,
  Field,
  HStack as SpatialHStack,
  List as SpatialList,
  Text as SpatialText,
  VStack as SpatialVStack,
} from "../../../../packages/ui/src/spatial/primitives.tsx";
