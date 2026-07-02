export interface MlKitTextWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
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
