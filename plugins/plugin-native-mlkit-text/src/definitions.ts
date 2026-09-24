/** Defines the complete native OCR word and recognition request contracts. */
export interface MlKitTextWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Actual engine confidence on a 0–100 scale, including fractional values. */
  confidence: number;
  block: number;
  par: number;
  line: number;
}

export interface RecognizeOptions {
  image: string;
  psm?: number;
}

export interface RecognizeResult {
  words: MlKitTextWord[];
}

export interface MlKitTextPlugin {
  recognize(options: RecognizeOptions): Promise<RecognizeResult>;
}
