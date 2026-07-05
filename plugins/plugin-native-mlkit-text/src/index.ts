/**
 * `@elizaos/capacitor-mlkit-text` — registers the Android ML Kit OCR bridge
 * under the plugin name `Tesseract`, kept for compatibility with the
 * existing UI bridge lookup and the stale #9649 branch's renderer contract.
 */

import { registerPlugin } from "@capacitor/core";

import type { MlKitTextPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () =>
  import("./web").then((module) => new module.MlKitTextWeb());

export const Tesseract = registerPlugin<MlKitTextPlugin>("Tesseract", {
  web: loadWeb,
});
