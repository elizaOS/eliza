/**
 * Web fallback for `@elizaos/capacitor-mlkit-text`. Unlike most native
 * bridges in this repo, there is no safe empty-data default for OCR — a
 * caller expecting recognized words cannot be handed an empty result and
 * proceed — so this throws explicitly rather than resolving.
 */

import { WebPlugin } from "@capacitor/core";

import type {
  MlKitTextPlugin,
  RecognizeOptions,
  RecognizeResult,
} from "./definitions";

export class MlKitTextWeb extends WebPlugin implements MlKitTextPlugin {
  async recognize(_options: RecognizeOptions): Promise<RecognizeResult> {
    throw new Error("ML Kit text recognition is only available on Android");
  }
}
