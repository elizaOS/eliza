// Side-effect barrel that registers every elizaOS Capacitor native plugin so
// it's available on mobile boot. Each import pulls in the plugin's
// `web.ts` / `native` registration code under the hood.
//
// The published `@elizaos/app-core` npm package contains this file as a
// publish-time generated entrypoint; the source tree version exists so
// `MILADY_ELIZA_SOURCE=local` consumers can resolve the same import path
// against linked workspace packages. Imports resolve through the
// `@elizaos/capacitor-*` path mappings in tsconfig{,.build}.json.
import "@elizaos/capacitor-camera";
import "@elizaos/capacitor-canvas";
import "@elizaos/capacitor-contacts";
import "@elizaos/capacitor-gateway";
import "@elizaos/capacitor-location";
import "@elizaos/capacitor-messages";
import "@elizaos/capacitor-mobile-signals";
import "@elizaos/capacitor-appblocker";
import "@elizaos/capacitor-bun-runtime";
import "@elizaos/capacitor-phone";
import "@elizaos/capacitor-screencapture";
import "@elizaos/capacitor-swabble";
import "@elizaos/capacitor-system";
import "@elizaos/capacitor-talkmode";
import "@elizaos/capacitor-websiteblocker";
