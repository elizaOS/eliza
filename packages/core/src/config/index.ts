/** Barrel for the runtime-agnostic config surface; React-eager modules are excluded so server boots stay React-free. */
export * from "@elizaos/core/config/allowed-hosts";
export * from "@elizaos/core/config/app-config";
export * from "@elizaos/core/config/boot-config";
// boot-config-react.tsx eagerly imports React; not barrel-exported so node-side
// consumers (bench server, agent boot) can import @elizaos/shared without
// pulling React into the runtime closure.
export * from "@elizaos/core/config/branding";
export * from "@elizaos/core/config/cloud-only";
export * from "@elizaos/core/config/config-catalog";
export * from "@elizaos/core/config/plugin-auto-enable";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "@elizaos/core/config/plugin-ui-spec";
export * from "@elizaos/core/config/runtime-mode";
export * from "@elizaos/core/config/types.eliza";
export * from "@elizaos/core/config/ui-spec";
