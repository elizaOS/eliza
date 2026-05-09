/**
 * Extract output schemas from n8n-nodes-base and @n8n/n8n-nodes-langchain
 * for expression validation.
 *
 * - n8n-nodes-base: scans __schema__/ dirs shipped with the package
 * - n8n-nodes-langchain: no __schema__ dirs, so output schemas are defined
 *   manually based on the actual source code of each operation
 *
 * Embeds the full schema content (not just paths) so validation works
 * at runtime without needing n8n-nodes-base installed.
 *
 * Run with: bun run crawl:schemas
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT = path.resolve(
  import.meta.dir,
  "..",
  "src",
  "data",
  "schemaIndex.json",
);
const LANGCHAIN_OVERRIDES = path.resolve(
  import.meta.dir,
  "..",
  "src",
  "data",
  "langchain-output-schemas.json",
);

// Full schema content embedded
interface SchemaContent {
  type: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SchemaEntry {
  folder: string; // Relative path from nodes/ (e.g., "Google/Gmail")
  schemas: Record<string, Record<string, SchemaContent>>; // resource → operation → full schema
}

interface SchemaIndex {
  nodeTypes: Record<string, SchemaEntry>;
  generatedAt: string;
  version: string;
}

async function findNodesBasePath(): Promise<string> {
  try {
    const resolved = require.resolve("n8n-nodes-base");
    return path.join(resolved, "..", "dist", "nodes");
  } catch {
    console.error("n8n-nodes-base not found. Run: bun add -d n8n-nodes-base");
    process.exit(1);
  }
}

async function* walkDir(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else {
      yield fullPath;
    }
  }
}

async function scanSchemaFolder(
  schemaDir: string,
): Promise<Record<string, Record<string, SchemaContent>>> {
  const schemas: Record<string, Record<string, SchemaContent>> = {};

  try {
    // Schemas are in: __schema__/v{version}/{resource}/{operation}.json
    // We take the highest version if multiple exist
    const versionDirs = await readdir(schemaDir, { withFileTypes: true });

    // Sort versions descending to get highest first
    const sortedVersions = versionDirs
      .filter((d) => d.isDirectory() && d.name.startsWith("v"))
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const versionName of sortedVersions) {
      const versionPath = path.join(schemaDir, versionName);
      const resourceDirs = await readdir(versionPath, { withFileTypes: true });

      for (const resourceDir of resourceDirs) {
        if (!resourceDir.isDirectory()) continue;

        const resource = resourceDir.name;
        const resourcePath = path.join(versionPath, resource);
        const operationFiles = await readdir(resourcePath, {
          withFileTypes: true,
        });

        if (!schemas[resource]) {
          schemas[resource] = {};
        }

        for (const opFile of operationFiles) {
          if (!opFile.isFile() || !opFile.name.endsWith(".json")) continue;

          const operation = opFile.name.replace(".json", "");

          // Only take first (highest version) schema for each operation
          if (schemas[resource][operation]) continue;

          try {
            const schemaPath = path.join(resourcePath, opFile.name);
            const content = await readFile(schemaPath, "utf-8");
            const schema = JSON.parse(content) as SchemaContent;
            schemas[resource][operation] = schema;
          } catch {
            // Skip invalid schema files
          }
        }
      }
    }
  } catch {
    // No schemas or error reading
  }

  return schemas;
}

async function main() {
  const nodesPath = await findNodesBasePath();
  console.log(`Scanning ${nodesPath} for schemas...`);

  const index: SchemaIndex = {
    nodeTypes: {},
    generatedAt: new Date().toISOString(),
    version: "2.0.0", // Version bump: now includes full schema content
  };

  // Find all .node.json files
  const nodeJsonFiles: string[] = [];
  for await (const filePath of walkDir(nodesPath)) {
    if (filePath.endsWith(".node.json")) {
      nodeJsonFiles.push(filePath);
    }
  }

  console.log(`Found ${nodeJsonFiles.length} node definition files`);

  let nodesWithSchemas = 0;
  let totalSchemas = 0;

  for (const nodeJsonPath of nodeJsonFiles) {
    try {
      const content = await readFile(nodeJsonPath, "utf-8");
      const nodeJson = JSON.parse(content);
      const nodeType = nodeJson.node as string;

      if (!nodeType) continue;

      // Get folder path relative to nodes/
      const nodeDir = path.dirname(nodeJsonPath);
      const relativeFolder = path.relative(nodesPath, nodeDir);

      // Check for __schema__ folder
      const schemaDir = path.join(nodeDir, "__schema__");
      const schemas = await scanSchemaFolder(schemaDir);

      const schemaCount = Object.values(schemas).reduce(
        (sum, ops) => sum + Object.keys(ops).length,
        0,
      );

      if (schemaCount > 0) {
        index.nodeTypes[nodeType] = {
          folder: relativeFolder,
          schemas,
        };
        nodesWithSchemas++;
        totalSchemas += schemaCount;
      }
    } catch {
      // Skip invalid files
    }
  }

  // Merge langchain override schemas (no __schema__ dirs in that package)
  try {
    const overrideRaw = await readFile(LANGCHAIN_OVERRIDES, "utf-8");
    const overrideData = JSON.parse(overrideRaw) as {
      nodes: Record<string, SchemaEntry>;
    };

    for (const [nodeType, entry] of Object.entries(overrideData.nodes)) {
      index.nodeTypes[nodeType] = entry;
      const count = Object.values(entry.schemas).reduce(
        (sum, ops) => sum + Object.keys(ops).length,
        0,
      );
      nodesWithSchemas++;
      totalSchemas += count;
      console.log(`  Added langchain override: ${nodeType} (${count} schemas)`);
    }
  } catch (error) {
    console.warn(
      `Warning: failed to load langchain overrides: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(index, null, 2), "utf-8");

  console.log(`\nSchema index created:`);
  console.log(`  - Nodes with schemas: ${nodesWithSchemas}`);
  console.log(`  - Total schema files: ${totalSchemas}`);
  console.log(`  - Output: ${OUTPUT}`);
}

main().catch((err) => {
  console.error("crawl-output-schemas failed:", err);
  process.exit(1);
});
