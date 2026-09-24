/**
 * Side-effect barrel that registers every elizaOS Capacitor native plugin so it
 * is available on mobile boot — each bare import pulls in that plugin's
 * `web.ts` / native registration code. The published `@elizaos/app` npm
 * package ships this as a publish-time-generated entrypoint; the source-tree
 * copy exists so `ELIZA_ELIZA_SOURCE=local` consumers can resolve the same
 * import path against linked workspace packages (imports resolve through the
 * `@elizaos/capacitor-*` path mappings in tsconfig{,.build}.json).
 */
import "@elizaos/capacitor-camera";
import "@elizaos/capacitor-canvas";
import "@elizaos/plugin-native-contacts/bridge";
import "@elizaos/capacitor-gateway";
import "@elizaos/capacitor-location";
import "@elizaos/plugin-native-messages/bridge";
import "@elizaos/plugin-native-inference/bridge";
import "@elizaos/capacitor-mobile-signals";
import "@elizaos/capacitor-appblocker";
import "@elizaos/capacitor-bun-runtime";
import "@elizaos/plugin-native-phone/bridge";
import "@elizaos/capacitor-screencapture";
import "@elizaos/capacitor-swabble";
import "@elizaos/capacitor-system";
import "@elizaos/capacitor-talkmode";
import "@elizaos/capacitor-websiteblocker";
// JS-runtime sandbox bridges register their factories as import-time side
// effects so resolveJsRuntimeBridge() can find jsc-ios / quickjs-* on boot.
import "../connectors/capacitor-jsc.ts";
import "../connectors/capacitor-quickjs.ts";
