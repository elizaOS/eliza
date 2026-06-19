import type { ComponentType, ReactNode } from "react";

export const AppProvider: ComponentType<{
  branding?: Record<string, unknown>;
  children?: ReactNode;
}>;

export function applyUiTheme(theme: unknown): void;
export function loadUiTheme(): unknown;
