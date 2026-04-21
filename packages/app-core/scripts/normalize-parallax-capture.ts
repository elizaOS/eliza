import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeParallaxCapture } from "../src/benchmark/replay-capture.ts";

interface CliArgs {
  input: string;
  output?: string;
  glob?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { input: "" };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--input") args.input = argv[++i] ?? "";
    else if (token === "--output") args.output = argv[++i];
    else if (token === "--glob") args.glob = argv[++i];
  }
  if (!args.input) {
    throw new Error(
      "Missing required --input argument. Example: --input /path/to/capture.json",
    );
  }
  return args;
}

function toReplayFilename(filePath: string): string {
  const parsed = path.parse(filePath);
  return `${parsed.name}.replay.json`;
}

function matchesSimpleGlob(filename: string, glob: string): boolean {
  // Minimal glob support for common patterns like *.json and *.capture.json.
  if (!glob.includes("*")) return filename === glob;
  const [prefix, suffix] = glob.split("*");
  return filename.startsWith(prefix) && filename.endsWith(suffix ?? "");
}

async function normalizeFile(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const raw = await readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const normalized = normalizeParallaxCapture(parsed);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const inputStat = await stat(inputPath);

  if (inputStat.isFile()) {
    const outputPath = path.resolve(
      args.output ??
        path.join(path.dirname(inputPath), toReplayFilename(inputPath)),
    );
    await normalizeFile(inputPath, outputPath);
    console.log(outputPath);
    return;
  }

  if (!inputStat.isDirectory()) {
    throw new Error(`Input path is neither file nor directory: ${inputPath}`);
  }

  const glob = args.glob ?? "*.json";
  const outDir = path.resolve(args.output ?? inputPath);
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  let normalizedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!matchesSimpleGlob(entry.name, glob)) continue;

    const sourceFile = path.join(inputPath, entry.name);
    const outputFile = path.join(outDir, toReplayFilename(entry.name));
    await normalizeFile(sourceFile, outputFile);
    normalizedCount += 1;
  }

  console.log(`${outDir} (${normalizedCount} files)`);
}

run().catch((error) => {
  console.error(
    `[normalize-parallax-capture] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
