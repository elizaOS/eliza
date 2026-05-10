import sharedConfig from "../tsup.plugin-packages.shared";

export default {
  ...sharedConfig,
  dts: true,
  external: [
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
