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
