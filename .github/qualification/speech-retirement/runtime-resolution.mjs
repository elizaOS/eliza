// Trusted operator probe only: builtin modules, no helper/test evaluation.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
const importer = "/workspace/packages/cloud/api/src";
const specifier = "../../shared/src/lib/services/inference-settlement-receipt";
const resolved = realpathSync(Bun.resolveSync(specifier, importer));
if (resolved !== "/workspace/packages/cloud/shared/src/lib/services/inference-settlement-receipt.ts") {
  throw new Error("Ordinary Bun source resolution selected an unexpected file");
}
console.log(JSON.stringify({version:Bun.version,platform:process.platform,arch:process.arch,
  bunSHA256:createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
  importer,specifier,resolved,
  resolvedSHA256:createHash("sha256").update(readFileSync(resolved)).digest("hex"),
  helperOrTestEvaluated:false,externalPackagesInstalled:false}));
