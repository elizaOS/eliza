export * from "./allowed-hosts";
export * from "./app-config";
export * from "./boot-config";
// boot-config-react.tsx eagerly imports React; not barrel-exported so node-side
// consumers (bench server, agent boot) can import @elizaos/shared without
// pulling React into the runtime closure. Import the file path directly from
// React-using code: import { ... } from "@elizaos/shared/config/boot-config-react";
export * from "./branding";
export * from "./cloud-only";
export * from "./config-catalog";
export * from "./plugin-auto-enable";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "./plugin-ui-spec";
export * from "./types.eliza";
export * from "./ui-spec";
