/**
 * Extract n8n node definitions from n8n-nodes-base and @n8n/n8n-nodes-langchain,
 * then write to defaultNodes.json.
 *
 * - n8n-nodes-base: installed as devDependency, read directly
 * - n8n-nodes-langchain: downloaded as tarball (82+ deps — not installed),
 *   only the openAi node is extracted to replace the deprecated n8n-nodes-base version
 *
 * Run with: bun run crawl:nodes
 */
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

const OUTPUT = path.resolve(
  import.meta.dir,
  "..",
  "src",
  "data",
  "defaultNodes.json",
);
const TMP_DIR = path.join(import.meta.dir, "..", ".tmp-langchain");

const KEEP_KEYS = [
  "name",
  "displayName",
  "group",
  "description",
  "version",
  "inputs",
  "outputs",
  "properties",
  "credentials",
  "documentationUrl",
] as const;

/** Langchain nodes that override their deprecated n8n-nodes-base counterpart. */
const LANGCHAIN_OVERRIDES = ["openAi"];

function filterKeys(node: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of KEEP_KEYS) {
    if (node[key] !== undefined) {
      filtered[key] = node[key];
    }
  }
  return filtered;
}

async function loadLangchainNodes(): Promise<
  Map<string, Record<string, unknown>>
> {
  const overrides = new Map<string, Record<string, unknown>>();

  try {
    await mkdir(TMP_DIR, { recursive: true });

    console.log("Downloading @n8n/n8n-nodes-langchain tarball...");
    execSync("npm pack @n8n/n8n-nodes-langchain", {
      cwd: TMP_DIR,
      stdio: "pipe",
    });

    const tgzFile = execSync("ls *.tgz", { cwd: TMP_DIR, encoding: "utf-8" })
      .trim()
      .split("\n")[0];
    execSync(`tar -xf "${tgzFile}" package/dist/types/nodes.json`, {
      cwd: TMP_DIR,
      stdio: "pipe",
    });

    const raw = await readFile(
      path.join(TMP_DIR, "package", "dist", "types", "nodes.json"),
      "utf-8",
    );
    const allNodes: Record<string, unknown>[] = JSON.parse(raw);
    console.log(`  Found ${allNodes.length} langchain node definitions`);

    for (const nodeName of LANGCHAIN_OVERRIDES) {
      const candidates = allNodes.filter((n) => n.name === nodeName);
      if (candidates.length === 0) {
        console.warn(`  Warning: ${nodeName} not found in langchain package`);
        continue;
      }

      const latest = candidates.reduce((best, cur) => {
        const bv = Array.isArray(best.version)
          ? Math.max(...(best.version as number[]))
          : ((best.version as number) ?? 0);
        const cv = Array.isArray(cur.version)
          ? Math.max(...(cur.version as number[]))
          : ((cur.version as number) ?? 0);
        return cv > bv ? cur : best;
      });

      const prefixed = filterKeys(latest);
      prefixed.name = `@n8n/n8n-nodes-langchain.${nodeName}`;
      overrides.set(nodeName, prefixed);
      console.log(
        `  Extracted ${prefixed.name} v${Array.isArray(latest.version) ? (latest.version as number[]).join("/") : latest.version} from langchain`,
      );
    }
  } catch (error) {
    console.warn(
      `Warning: failed to load langchain nodes (catalog will use n8n-nodes-base only): ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  }

  return overrides;
}

async function main() {
  let nodesBasePath: string;
  try {
    nodesBasePath = require.resolve("n8n-nodes-base");
  } catch {
    console.error("n8n-nodes-base not found. Run: bun add -d n8n-nodes-base");
    process.exit(1);
  }

  const langchainOverrides = await loadLangchainNodes();

  const typesPath = path.join(
    nodesBasePath,
    "..",
    "dist",
    "types",
    "nodes.json",
  );
  console.log(`Reading ${typesPath} ...`);

  const raw = await readFile(typesPath, "utf-8");
  const allNodes: Record<string, unknown>[] = JSON.parse(raw);
  console.log(`Found ${allNodes.length} base node definitions`);

  const seen = new Set<string>();
  const nodes: Record<string, unknown>[] = [];

  for (const node of allNodes) {
    const name = node.name as string;
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const override = langchainOverrides.get(name);
    if (override) {
      nodes.push(override);
      console.log(`  Replaced ${name} with langchain version`);
    } else {
      const prefixed = filterKeys(node);
      prefixed.name = `n8n-nodes-base.${name}`;
      nodes.push(prefixed);
    }
  }

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(nodes, null, 2), "utf-8");
  console.log(`Wrote ${nodes.length} unique nodes to ${OUTPUT}`);
}

main().catch((err) => {
  console.error("crawl-nodes failed:", err);
  process.exit(1);
});
