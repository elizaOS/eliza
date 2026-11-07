import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const cloud = path.join(root, "packages/cloud");
const sourceExtensions = [
  ".ts",
  ".tsx",
  ".sql",
  ".lua",
  ".py",
  ".go",
  ".rs",
  ".proto",
  ".sh",
];
const sourceExtensionSet = new Set(sourceExtensions);
function isSource(file: string): boolean {
  return (
    sourceExtensionSet.has(path.extname(file)) &&
    !/\.(test|spec|integration)\.|(?:^|\/)test_|_test\.py$/.test(file)
  );
}
const manifest = JSON.parse(
  readFileSync(path.join(cloud, "formal/contracts.json"), "utf8"),
) as {
  models: Array<{ id: string; sources: string[] }>;
};
const candidates: Array<{
  file: string;
  sha256: string;
  models: string[];
  signals: Array<{ line: number; kind: string; text: string }>;
}> = [];
let scannedFiles = 0;
function scan(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !/^(node_modules|test-results|dist|build|\.git|\.wrangler|formal|__tests__|test|tests|e2e)$/.test(
          entry.name,
        )
      )
        scan(absolute);
      continue;
    }
    if (!isSource(entry.name)) continue;
    const source = readFileSync(absolute, "utf8");
    scannedFiles++;
    const signals: Array<{ line: number; kind: string; text: string }> = [];
    for (const [index, line] of source.split("\n").entries()) {
      const kind =
        /(?:status|phase|state|generation|lease|fence|receipt|idempotenc|retry|abort|cancel|claim|settle)/i.test(
          line,
        )
          ? /(?:type\s+\w+|enum\s+\w+|class\s+\w+.*\bEnum\b|z\.enum|CHECK\s*\()/i.test(
              line,
            )
            ? "declaration"
            : /(?:update|set|compare|transition|\b(?:status|phase|state)\s*[:=])/i.test(
                  line,
                )
              ? "transition-candidate"
              : undefined
          : undefined;
      if (kind) signals.push({ line: index + 1, kind, text: line.trim() });
    }
    if (!signals.length) continue;
    const file = path.relative(root, absolute);
    candidates.push({
      file,
      sha256: createHash("sha256").update(source).digest("hex"),
      models: manifest.models
        .filter((model) => model.sources.includes(file))
        .map((model) => model.id),
      signals,
    });
  }
}
scan(cloud);
const missingSources = execFileSync(
  "git",
  ["ls-files", "-z", "packages/cloud"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(isSource)
  .filter(
    (file) =>
      !/(?:^|\/)(?:node_modules|dist|build|formal|__tests__|test|tests|e2e)\//.test(
        file,
      ),
  )
  .filter((file) => !existsSync(path.join(root, file)));
candidates.sort((left, right) => left.file.localeCompare(right.file));
const output = testOutputPath("cloud-formal", "inventory");
const reviewedDirectory = path.join(cloud, "formal/inventory");
const reviewedInventory = existsSync(reviewedDirectory)
  ? readdirSync(reviewedDirectory)
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        JSON.parse(readFileSync(path.join(reviewedDirectory, file), "utf8")),
      )
  : [];
mkdirSync(output, { recursive: true });
writeFileSync(
  path.join(output, "candidates.json"),
  `${JSON.stringify(
    {
      purpose:
        "Heuristic source discovery. A model link is not a proof of implementation coverage or completeness.",
      scannedFiles,
      sourceExtensions,
      selectedSourcesPresent: missingSources.length === 0,
      protocolCoverageComplete: false,
      missingSources,
      reviewedInventory,
      candidates,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Scanned ${scannedFiles} source files; ${candidates.length} contain protocol signals. Report: ${output}`,
);
