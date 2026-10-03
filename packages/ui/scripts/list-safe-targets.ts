/**
 * Lists component-story candidates from the current source inventory.
 */
import { buildStoryCoverage } from "./stories-coverage.ts";

const report = buildStoryCoverage();

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
