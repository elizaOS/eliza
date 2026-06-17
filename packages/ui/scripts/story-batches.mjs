import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(
  fs.readFileSync(path.join(here, "stories-coverage-report.json"), "utf8"),
);
const norm = (m) => m.split(path.sep).join("/");

// Infrastructure / non-presentational — should NOT get stories.
const EXCLUDE = new Set([
  "src/App.tsx",
  "src/agent-surface/AgentSurfaceContext.tsx",
  "src/state/AppContext.tsx",
  "src/state/TranslationProvider.tsx",
  "src/hooks/BugReportProvider.tsx",
  "src/components/shell/ShellControllerContext.tsx",
  "src/cloud-ui/runtime/image.tsx",
  "src/cloud-ui/runtime/render-telemetry.tsx",
  "src/slots/task-coordinator-slots.tsx",
  // .helpers/.data-like utility modules that slipped through (exported tsx utils)
  "src/components/pages/database-utils.tsx",
]);

const missing = r.missing.map(norm).filter((m) => !EXCLUDE.has(m));

const inDir = (m, dir) => m.startsWith(dir);

const batchA = missing.filter(
  (m) =>
    inDir(m, "src/components/pages/") || inDir(m, "src/components/pages/relationships/"),
);
const batchB = missing.filter((m) => inDir(m, "src/components/settings/"));
const used = new Set([...batchA, ...batchB]);
const batchC = missing.filter((m) => !used.has(m));

const out = { batchA, batchB, batchC, total: missing.length };
fs.writeFileSync(
  path.join(here, "story-batches.json"),
  JSON.stringify(out, null, 2),
);
console.log(
  `A(pages)=${batchA.length} B(settings)=${batchB.length} C(rest)=${batchC.length} total=${missing.length}`,
);
