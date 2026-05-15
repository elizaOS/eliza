export interface Message {
  text: string;
}

export interface BuildResult {
  outputFiles?: Array<{ text: string }>;
  warnings: Message[];
}

export async function build(): Promise<BuildResult> {
  throw new Error("esbuild is not available in UI tests");
}
