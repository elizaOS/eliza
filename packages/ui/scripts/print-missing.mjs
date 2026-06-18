import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(
  fs.readFileSync(path.join(here, "stories-coverage-report.json"), "utf8"),
);
for (const m of r.missing) console.log(m.split(path.sep).join("/"));
