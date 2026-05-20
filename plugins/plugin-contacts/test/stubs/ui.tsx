import React from "react";

export type OverlayAppContext = {
  exitToApps?: () => void;
  t?: (key: string) => string;
};

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

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input(props, ref) {
  return React.createElement("input", { ...props, ref });
});

export function isElizaOS(): boolean {
  return false;
}

export function registerOverlayApp(): void {}
