/**
 * Disables optional wallet analytics in the Android Cloud renderer at build time.
 * Coinbase/Base analytics embeds service-worker messaging, which is outside that
 * renderer's routing policy. Wallet transports and signing remain unchanged.
 */
import type { Plugin } from "vite";

export function androidCloudWalletTelemetryPlugin(enabled: boolean): Plugin {
  return {
    name: "android-cloud-wallet-telemetry",
    enforce: "pre",
    transform(code, id) {
      if (!enabled) return;
      const filename = id.replaceAll("\\", "/").split("?")[0];
      const coinbase = filename.endsWith(
        "/@coinbase/wallet-sdk/dist/CoinbaseWalletSDK.js",
      );
      const base = filename.endsWith(
        "/@base-org/account/dist/interface/builder/core/createBaseAccountSDK.js",
      );
      const coinbaseFactory = filename.endsWith(
        "/@coinbase/wallet-sdk/dist/createCoinbaseWalletSDK.js",
      );
      if (!coinbase && !base && !coinbaseFactory) return;
      // The Solana adapter also installs wallet-sdk v3, which has no analytics
      // loader. Only SDKs with the optional loader need the build-time opt-out.
      if (!code.includes("loadTelemetryScript")) return;
      const condition = coinbase
        ? "preference.telemetry !== false"
        : "options.preference.telemetry !== false";
      if (!code.includes(condition)) {
        throw new Error(`Wallet telemetry opt-out changed in ${filename}`);
      }
      const withoutLoader = code.replace(
        /import \{ loadTelemetryScript \} from ['"][^'"]+initCCA\.js['"];?\s*/,
        "",
      );
      if (withoutLoader === code) {
        throw new Error(`Wallet telemetry import changed in ${filename}`);
      }
      return {
        code: withoutLoader
          .replace(condition, "false")
          .replace("void loadTelemetryScript();", ""),
        map: null,
      };
    },
  };
}
