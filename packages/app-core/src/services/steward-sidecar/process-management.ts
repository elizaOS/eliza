import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

function resolveOptionalModuleEntry(specifier: string): string | null {
  try {
    const resolved = import.meta.resolve(specifier);
    return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
  } catch {
    return null;
  }
}

/**
 * Find the Steward API entry point on disk.
 */
export async function findStewardEntryPoint(): Promise<string | null> {
  const candidates = [
    process.env.STEWARD_ENTRY_POINT,
    resolveOptionalModuleEntry("@stwd/api/embedded"),
    resolveOptionalModuleEntry("@stwd/api"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`[StewardSidecar] Found entry point: ${candidate}`);
      return candidate;
    }
  }

  return null;
}

/**
 * Pipe a ReadableStream to console, calling onLog for each line.
 */
export async function pipeOutput(
  stream: ReadableStream<Uint8Array> | null,
  name: "stdout" | "stderr",
  onLog?: (line: string, stream: "stdout" | "stderr") => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value).trimEnd();
      if (text) {
        const prefix = name === "stderr" ? "[Steward:err]" : "[Steward]";
        console.log(`${prefix} ${text}`);
        onLog?.(text, name);
      }
    }
  } catch {
    // stream closed
  }
}
