import type React from "react";

export type ElizaGenUiVersion = "0.1";

export type A2UiCompatibilityVersion = "0.9";

export type ElizaGenUiJsonPrimitive = string | number | boolean | null;

export type ElizaGenUiJsonValue =
  | ElizaGenUiJsonPrimitive
  | { [key: string]: ElizaGenUiJsonValue }
  | ElizaGenUiJsonValue[];

export type ElizaGenUiChildrenBinding = {
  path: string;
  componentId: string;
};

export type ElizaGenUiAction = {
  event: {
    name: string;
    payload?: ElizaGenUiJsonValue;
  };
};

export type ElizaGenUiComponent = {
  id: string;
  component: string;
  children?: string[] | ElizaGenUiChildrenBinding;
  child?: string;
  action?: ElizaGenUiAction;
} & {
  [prop: string]:
    | ElizaGenUiJsonValue
    | ElizaGenUiAction
    | string[]
    | ElizaGenUiChildrenBinding
    | undefined;
};

export type ElizaGenUiSpec = {
  version: ElizaGenUiVersion;
  a2uiVersion?: A2UiCompatibilityVersion;
  root: string;
  components: ElizaGenUiComponent[];
  data?: Record<string, ElizaGenUiJsonValue>;
  metadata?: Record<string, ElizaGenUiJsonValue>;
};

export type ElizaGenUiActionTarget =
  | "plugin"
  | "runtime"
  | "capability"
  | "setup"
  | "dynamic-view"
  | "trace"
  | "voice";

export type ElizaGenUiActionResult = {
  ok: boolean;
  data?: ElizaGenUiJsonValue;
  error?: string;
};

export type ElizaGenUiActionContext = {
  target?: ElizaGenUiActionTarget;
  spec?: ElizaGenUiSpec;
  componentId?: string;
  sessionId?: string;
  data?: Record<string, ElizaGenUiJsonValue>;
};

export type ElizaGenUiActionHandler = {
  canHandle(eventName: string): boolean;
  handle(
    action: ElizaGenUiAction,
    context: ElizaGenUiActionContext,
  ): Promise<ElizaGenUiActionResult>;
};

export type ElizaGenUiValidationIssue = {
  code:
    | "invalid_spec"
    | "invalid_version"
    | "invalid_root"
    | "invalid_component"
    | "duplicate_id"
    | "unknown_component"
    | "missing_child"
    | "invalid_action"
    | "unsafe_url"
    | "unsafe_field"
    | "too_large"
    | "too_many_components";
  message: string;
  componentId?: string;
  path?: string;
};

export type ElizaGenUiValidationResult =
  | { ok: true; spec: ElizaGenUiSpec }
  | { ok: false; errors: ElizaGenUiValidationIssue[] };

export type ElizaGenUiValidationOptions = {
  maxComponents?: number;
  maxJsonBytes?: number;
  allowedActionPrefixes?: readonly string[];
  allowedActionNames?: readonly string[];
};

export type ElizaGenUiPatchOperation = "add" | "replace" | "remove";

export type ElizaGenUiPatch = {
  op: ElizaGenUiPatchOperation;
  path: string;
  value?: ElizaGenUiJsonValue;
};

export type ElizaGenUiPatchResult =
  | { ok: true; spec: ElizaGenUiSpec }
  | { ok: false; errors: ElizaGenUiValidationIssue[] };

export type ElizaGenUiRendererProps = {
  spec: ElizaGenUiSpec;
  actionHandlers?: readonly ElizaGenUiActionHandler[];
  context?: ElizaGenUiActionContext;
  devMode?: boolean;
  className?: string;
  onActionError?: (error: Error, action: ElizaGenUiAction) => void;
};

export type ElizaGenUiRenderContext = {
  spec: ElizaGenUiSpec;
  componentsById: Map<string, ElizaGenUiComponent>;
  actionHandlers: readonly ElizaGenUiActionHandler[];
  context: ElizaGenUiActionContext;
  onActionError?: (error: Error, action: ElizaGenUiAction) => void;
  renderComponent: (
    componentId: string | undefined,
    stack?: readonly string[],
  ) => React.ReactNode;
};
