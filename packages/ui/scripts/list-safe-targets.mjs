/**
 * Lists the audit-safe UI targets from the report JSON, for the regression-gate
 * tooling.
 */
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\//, "");
const report = JSON.parse(
  fs.readFileSync(path.join(here, "stories-coverage-report.json"), "utf8"),
);

const safePrefixes = [
  "src/components/composites/",
  "src/components/accounts/",
  "src/components/conversations/",
  "src/components/release-center/",
  "src/components/desktop/",
  "src/components/stream/",
  "src/components/tool-events/",
  "src/components/voice-pill/",
  "src/components/shared/",
  "src/components/views/",
  "src/components/permissions/",
  "src/components/config-ui/",
  "src/components/setup/",
  "src/components/custom-actions/",
];

const norm = (p) => p.replace(/\\/g, "/");
const targets = report.missing.filter((m) =>
  safePrefixes.some((p) => norm(m).startsWith(p)),
);
for (const t of targets) console.log(norm(t));
console.error(`Total safe targets: ${targets.length}`);
