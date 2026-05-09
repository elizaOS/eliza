/**
 * Master crawl script - generates all data indexes from n8n-nodes-base.
 *
 * Run with: bun run crawl
 *
 * Generates:
 * - src/data/defaultNodes.json (node catalog)
 * - src/data/schemaIndex.json (output schema index)
 * - src/data/triggerSchemaIndex.json (trigger output schemas, requires WORKFLOW_HOST + WORKFLOW_API_KEY)
 */

import { $ } from "bun";

async function main() {
  console.log("=== Crawling n8n-nodes-base ===\n");

  console.log("1/3: Crawling node definitions...");
  await $`bun run scripts/crawl-nodes.ts`;

  console.log("\n2/3: Crawling output schemas...");
  await $`bun run scripts/crawl-output-schemas.ts`;

  console.log("\n3/3: Capturing trigger schemas...");
  if (process.env.WORKFLOW_HOST && process.env.WORKFLOW_API_KEY) {
    await $`bun run scripts/crawl-triggers-live.ts --from-existing`;
  } else {
    console.log("   Skipped (WORKFLOW_HOST / WORKFLOW_API_KEY not set)");
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Crawl failed:", err);
  process.exit(1);
});
