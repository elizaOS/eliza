import type { ElectrobunConfig } from "electrobun/bun";

export default {
  app: {
    name: "elizaOS USB Installer",
    identifier: "ai.elizaos.usb-installer",
    version: "1.0.0",
    description: "Prepare bootable elizaOS USB installers",
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
    },
    views: {},
    copy: {},
    mac: {
      codesign: Boolean(process.env.CSC_LINK),
      notarize: Boolean(process.env.APPLE_ID),
      entitlements: {
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
        "com.apple.security.network.client": true,
        "com.apple.security.automation.apple-events": true,
      },
    },
    linux: {},
    win: {},
  },
} satisfies ElectrobunConfig;
