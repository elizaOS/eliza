/**
 * Steward Sidecar — process spawning and entry point resolution.
 */

/**
 * Find the Steward API entry point on disk.
 * Searches common locations: env override, monorepo sibling, node_modules.
 */
export async function findStewardEntryPoint(): Promise<string | null> {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const candidates = [
      // Absolute paths from env (highest priority)
      process.env.STEWARD_ENTRY_POINT,
      // Monorepo sibling — embedded entry point (PGLite, no external DB needed)
      path.resolve(
        __dirname,
        "../../../../steward-fi/packages/api/src/embedded.ts",
      ),
      // Known absolute path on dev machines
      path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        "projects/steward-fi/packages/api/src/embedded.ts",
      ),
      // Monorepo sibling — regular entry point (needs DATABASE_URL)
      path.resolve(
        __dirname,
        "../../../../steward-fi/packages/api/src/index.ts",
      ),
      // Installed as dependency
      path.resolve(
        __dirname,
        "../../../node_modules/@stwd/api/src/embedded.ts",
      ),
      path.resolve(__dirname, "../../../node_modules/@stwd/api/src/index.ts"),
      // Relative to workspace
      path.resolve(process.cwd(), "node_modules/@stwd/api/src/embedded.ts"),
      path.resolve(process.cwd(), "node_modules/@stwd/api/src/index.ts"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        console.log(`[StewardSidecar] Found entry point: ${candidate}`);
        return candidate;
      }
    }

    return null;
  } catch {
    return null;
  }
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
