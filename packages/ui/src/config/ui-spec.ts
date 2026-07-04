/**
 * Re-exports the UI-spec type surface (actions, visibility, auth state, …) the
 * plugin-config engine and renderer share.
 */
export type {
  ActionConfirm,
  ActionOnError,
  ActionOnSuccess,
  AndVisibility,
  AuthState,
  AuthVisibility,
  BuiltinValidator,
  CondExpr,
  DynamicProp,
  NotVisibility,
  OrVisibility,
  PatchOp,
  PathVisibility,
  RepeatConfig,
  UIStreamConfig,
  UiAction,
  UiComponentType,
  UiElement,
  UiEventBindings,
  UiRenderContext,
  UiSpec,
  UiSpecValidationCheck,
  UiSpecValidationConfig,
  UiSpecVisibilityCondition,
  VisibilityOperator,
} from "@elizaos/shared";
