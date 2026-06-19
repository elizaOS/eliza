import type { ComponentType, RefObject } from "react";

declare module "@elizaos/ui" {
  export const TerminalPluginView: ComponentType<Record<string, unknown>>;
}

declare module "@elizaos/ui/agent-surface" {
  export interface UseAgentElementOptions {
    id: string;
    role: string;
    label: string;
    group?: string;
    status?: string;
    description?: string;
    getValue?: () => unknown;
    onActivate?: () => void | Promise<void>;
    [key: string]: unknown;
  }

  export function useAgentElement<TElement extends HTMLElement>(
    options: UseAgentElementOptions,
  ): {
    ref: RefObject<TElement | null>;
    agentProps: Record<string, unknown>;
  };
}

declare module "@elizaos/ui/app-shell-registry" {
  export type AppShellPageLoader = () => Promise<{
    default: ComponentType<Record<string, unknown>>;
    cleanup?: () => void | Promise<void>;
  }>;

  export interface AppShellPageRegistration {
    id: string;
    pluginId: string;
    label: string;
    icon?: string;
    path: string;
    order?: number;
    developerOnly?: boolean;
    group?: string;
    Component?: ComponentType<unknown>;
    loader?: AppShellPageLoader;
  }

  export function registerAppShellPage(
    registration: AppShellPageRegistration,
  ): void;
}
