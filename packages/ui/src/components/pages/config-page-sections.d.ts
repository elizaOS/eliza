/**
 * Sub-components and helpers for ConfigPageView.
 * Extracted from ConfigPageView.tsx.
 */
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { TranslateFn as AppTranslateFn, ConfigUiHint } from "../../types";
export type RpcProviderOption<T extends string> = {
  id: T;
  label: string;
};
export type TranslateOptions = Record<string, unknown>;
export type TranslateFn = AppTranslateFn;
export type RpcFieldDefinition = {
  configKey: string;
  label: string;
  isSet: boolean;
};
export type RpcFieldGroup = ReadonlyArray<RpcFieldDefinition>;
export type RpcSectionConfigMap = Record<string, RpcFieldGroup>;
export declare const EVM_RPC_OPTIONS: readonly [
  {
    readonly id: "eliza-cloud";
    readonly label: "Eliza Cloud";
  },
  {
    readonly id: "alchemy";
    readonly label: "Alchemy";
  },
  {
    readonly id: "infura";
    readonly label: "Infura";
  },
  {
    readonly id: "ankr";
    readonly label: "Ankr";
  },
];
export declare const BSC_RPC_OPTIONS: readonly [
  {
    readonly id: "eliza-cloud";
    readonly label: "Eliza Cloud";
  },
  {
    readonly id: "alchemy";
    readonly label: "Alchemy";
  },
  {
    readonly id: "ankr";
    readonly label: "Ankr";
  },
  {
    readonly id: "nodereal";
    readonly label: "NodeReal";
  },
  {
    readonly id: "quicknode";
    readonly label: "QuickNode";
  },
];
export declare const SOLANA_RPC_OPTIONS: readonly [
  {
    readonly id: "eliza-cloud";
    readonly label: "Eliza Cloud";
  },
  {
    readonly id: "helius-birdeye";
    readonly label: "Helius + Birdeye";
  },
];
export type CloudRpcStatusProps = {
  connected: boolean;
  loginBusy: boolean;
  onLogin: () => void;
};
export declare function CloudRpcStatus({
  connected,
  loginBusy,
  onLogin,
}: CloudRpcStatusProps): import("react/jsx-runtime").JSX.Element | null;
export declare function buildRpcRendererConfig(
  t: TranslateFn,
  selectedProvider: string,
  providerConfigs: RpcSectionConfigMap,
  rpcFieldValues: Record<string, string>,
): {
  schema: JsonSchemaObject;
  hints: Record<string, ConfigUiHint>;
  values: Record<string, unknown>;
  setKeys: Set<string>;
} | null;
type RpcSectionCloudProps = CloudRpcStatusProps;
type RpcSectionProps<T extends string> = {
  title: string;
  description: string;
  options: readonly RpcProviderOption<T>[];
  selectedProvider: T;
  onSelect: (provider: T) => void;
  providerConfigs: RpcSectionConfigMap;
  rpcFieldValues: Record<string, string>;
  onRpcFieldChange: (key: string, value: unknown) => void;
  cloud: RpcSectionCloudProps;
  containerClassName: string;
  t: TranslateFn;
};
export declare function RpcConfigSection<T extends string>({
  title,
  description,
  options,
  selectedProvider,
  onSelect,
  providerConfigs,
  rpcFieldValues,
  onRpcFieldChange,
  cloud,
  containerClassName,
  t,
}: RpcSectionProps<T>): import("react/jsx-runtime").JSX.Element;
export declare function renderRpcProviderButtons<T extends string>(
  options: readonly RpcProviderOption<T>[],
  selectedProvider: T,
  onSelect: (provider: T) => void,
  containerClassName: string,
  tFallback?: (key: string) => string,
): import("react/jsx-runtime").JSX.Element;
export declare function CloudServicesSection():
  | import("react/jsx-runtime").JSX.Element
  | null;
//# sourceMappingURL=config-page-sections.d.ts.map
