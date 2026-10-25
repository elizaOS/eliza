/** Registers the Android ML Kit OCR bridge with its stable Tesseract native name. */
import { registerPlugin } from "@capacitor/core";

import type { MlKitTextPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () =>
  import("./web").then((module) => new module.MlKitTextWeb());

export const Tesseract = registerPlugin<MlKitTextPlugin>("Tesseract", {
  web: loadWeb,
});
