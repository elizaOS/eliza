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
        "../../../../../steward-fi/packages/api/src/embedded.ts",
      ),
      path.resolve(process.cwd(), "steward-fi/packages/api/src/embedded.ts"),
      // Known absolute path on dev machines
      path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        "projects/steward-fi/packages/api/src/embedded.ts",
      ),
      // Monorepo sibling — regular entry point (needs DATABASE_URL)
      path.resolve(
        __dirname,
        "../../../../../steward-fi/packages/api/src/index.ts",
      ),
      path.resolve(process.cwd(), "steward-fi/packages/api/src/index.ts"),
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

export function resolveStewardWorkspaceRoot(entryPoint: string): string | null {
  const normalized = entryPoint.replace(/\\/g, "/");
  const marker = "/steward-fi/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) {
    return null;
  }

  return normalized.slice(0, idx + marker.length - 1);
}

interface BunInstallResult {
  code: number | null;
  output: string;
}

function isFrozenLockfileMismatch(output: string): boolean {
  return output.includes("lockfile had changes, but lockfile is frozen");
}

async function runBunInstall(
  workspaceRoot: string,
  args: string[],
  onLog?: (line: string, stream: "stdout" | "stderr") => void,
): Promise<BunInstallResult> {
  const { spawn } = await import("node:child_process");

  return new Promise<BunInstallResult>((resolve, reject) => {
    const lines: string[] = [];
    const child = spawn("bun", args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trimEnd();
      if (!line) return;
      lines.push(line);
      console.log(`[StewardBootstrap] ${line}`);
      onLog?.(line, "stdout");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trimEnd();
      if (!line) return;
      lines.push(line);
      console.log(`[StewardBootstrap:err] ${line}`);
      onLog?.(line, "stderr");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      resolve({
        code,
        output: lines.join("\n"),
      });
    });
  });
}

/**
 * Ensure repo-local steward-fi workspace dependencies exist before executing
 * the API directly from source.
 */
export async function ensureStewardWorkspaceReady(
  entryPoint: string,
  onLog?: (line: string, stream: "stdout" | "stderr") => void,
): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const workspaceRoot = resolveStewardWorkspaceRoot(entryPoint);
  if (!workspaceRoot) {
    return;
  }

  const requiredPackage = path.join(
    workspaceRoot,
    "node_modules",
    "@stwd",
    "db",
    "package.json",
  );
  if (fs.existsSync(requiredPackage)) {
    return;
  }

  console.log(
    `[StewardSidecar] Bootstrapping steward workspace dependencies in ${workspaceRoot}`,
  );

  const frozenResult = await runBunInstall(
    workspaceRoot,
    ["install", "--frozen-lockfile"],
    onLog,
  );
  if (frozenResult.code === 0) {
    return;
  }

  if (!isFrozenLockfileMismatch(frozenResult.output)) {
    throw new Error(
      `Steward workspace bootstrap failed with exit code ${frozenResult.code ?? "unknown"}`,
    );
  }

  console.warn(
    "[StewardSidecar] steward-fi lockfile is stale; retrying install without writing lockfile",
  );

  const fallbackResult = await runBunInstall(
    workspaceRoot,
    ["install", "--no-save"],
    onLog,
  );
  if (fallbackResult.code === 0) {
    return;
  }

  throw new Error(
    `Steward workspace bootstrap failed with exit code ${fallbackResult.code ?? "unknown"}`,
  );
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
