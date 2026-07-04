/**
 * tsup build config: extends the shared plugin-packages preset, marking the
 * runtime, cloud, and native-binding deps as external so they resolve from the
 * host rather than being bundled into the plugin's dist output.
 */
import sharedConfig from "../tsup.plugin-packages.shared";

export default {
  ...sharedConfig,
  external: [
    "@elizaos/cloud-shared",
    "@elizaos/cloud-routing",
    "@elizaos/core",
    "@elizaos/shared",
    "@napi-rs/keyring",
    "dotenv",
    "fs",
    "path",
    "@reflink/reflink",
    "@node-llama-cpp",
    "https",
    "http",
    "agentkeepalive",
    "zod",
  ],
};
