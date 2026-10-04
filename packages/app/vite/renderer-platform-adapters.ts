/** Browser adapters for optional Node capability discovery and the native scanner test fixture. */
import type { Plugin } from "vite";

export function rendererPlatformAdaptersPlugin(options: {
  isCapacitorMobileBuild: boolean;
  testAuth: boolean;
}): Plugin {
  const prefix = "\0renderer-platform:";
  return {
    name: "renderer-platform-adapters",
    enforce: "pre",
    resolveId(id) {
      if (
        id === "@protobufjs/inquire" ||
        (options.testAuth &&
          !options.isCapacitorMobileBuild &&
          id === "@capacitor/barcode-scanner")
      ) {
        return prefix + id;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      const strippedId = id.slice(prefix.length);
      if (strippedId === "@protobufjs/inquire") {
        return "export default function inquire() { return null; }";
      }
      if (strippedId === "@capacitor/barcode-scanner") {
        return [
          "const scanBarcode = async (options) => {",
          "  const root = typeof window !== 'undefined' ? window : globalThis;",
          "  const hook = root.__elizaUiSmokeBarcodeScanner;",
          "  if (hook && typeof hook.scanBarcode === 'function') {",
          "    return hook.scanBarcode(options);",
          "  }",
          "  const raw = root.localStorage?.getItem('__elizaUiSmokeBarcodeScannerResult');",
          "  if (raw) {",
          "    return JSON.parse(raw);",
          "  }",
          "  throw new Error('Barcode scanning requires a native platform or an injected browser test scanner.');",
          "};",
          "export const CapacitorBarcodeScanner = { scanBarcode };",
          "export const CapacitorBarcodeScannerTypeHint = Object.freeze({ QR_CODE: 'QR_CODE' });",
          "export default CapacitorBarcodeScanner;",
        ].join("\n");
      }
      return null;
    },
  };
}
