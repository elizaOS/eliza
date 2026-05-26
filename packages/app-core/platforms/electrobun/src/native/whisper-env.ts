import fs from "node:fs";
import path from "node:path";

export interface BundledWhisperRuntime {
  directory: string;
  libraryPath: string;
  modelPath: string;
}

function platformAdapterName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "libwhisper_eliza_adapter.dylib";
  if (platform === "win32") return "whisper_eliza_adapter.dll";
  return "libwhisper_eliza_adapter.so";
}

function prependEnvPath(
  env: Record<string, string>,
  key: string,
  directory: string,
): void {
  const existing = env[key];
  if (!existing) {
    env[key] = directory;
    return;
  }
  if (existing.split(path.delimiter).includes(directory)) return;
  env[key] = `${directory}${path.delimiter}${existing}`;
}

export function resolveBundledWhisperRuntime(
  runtimeDistPath: string,
  platform: NodeJS.Platform = process.platform,
): BundledWhisperRuntime | null {
  const directory = path.join(runtimeDistPath, "voice", "whisper");
  const libraryPath = path.join(directory, platformAdapterName(platform));
  const modelPath = path.join(directory, "ggml-base.en.bin");
  if (!fs.existsSync(libraryPath) || !fs.existsSync(modelPath)) return null;
  return { directory, libraryPath, modelPath };
}

export function applyBundledWhisperEnv(
  env: Record<string, string>,
  runtimeDistPath: string,
  platform: NodeJS.Platform = process.platform,
): BundledWhisperRuntime | null {
  const runtime = resolveBundledWhisperRuntime(runtimeDistPath, platform);
  if (!runtime) return null;
  if (!env.ELIZA_WHISPER_LIBRARY) {
    env.ELIZA_WHISPER_LIBRARY = runtime.libraryPath;
  }
  if (!env.ELIZA_WHISPER_MODEL) {
    env.ELIZA_WHISPER_MODEL = runtime.modelPath;
  }
  if (!env.ELIZA_WHISPER_MODEL_NAME) {
    env.ELIZA_WHISPER_MODEL_NAME = "base.en";
  }
  if (!env.ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP) {
    env.ELIZA_LOCAL_ASR_ALLOW_WHISPER_CPP = "1";
  }
  if (platform === "win32") {
    prependEnvPath(env, "PATH", runtime.directory);
  } else if (platform === "darwin") {
    prependEnvPath(env, "DYLD_LIBRARY_PATH", runtime.directory);
  } else {
    prependEnvPath(env, "LD_LIBRARY_PATH", runtime.directory);
  }
  return runtime;
}
