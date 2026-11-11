import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const output = testOutputPath("quint-managed-calendar-pull");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const cases = [
  {
    file: "test/calendar-managed-default-feed.pglite.test.ts",
    label: "mapped",
    names: [
      "managed owner calendars in the aggregate feed pulls a mapped managed edit and deletion into the local row before returning one feed",
      "managed owner calendars in the aggregate feed starts managed discovery while standard Google discovery is pending",
      "managed owner calendars in the aggregate feed cancels a pending managed catalog if standard Google discovery fails",
      "managed owner calendars in the aggregate feed reads an exact managed grant without looking up standard Google accounts",
      "managed owner calendars in the aggregate feed merges the built-in calendar with every calendar the host shows, once each",
      "managed owner calendars in the aggregate feed applies the host default to rows seeded hidden and keeps an owner's choice",
      "managed owner feeds in one aggregate read reads at most four managed calendars at once and keeps calendar order",
      "managed owner feeds in one aggregate read degrades and reports one failed managed calendar on its own",
      "managed owner feeds in one aggregate read shares the four-read bound across overlapping aggregate reads",
      "managed owner feeds in one aggregate read stops waiting and in-flight managed reads when another source branch throws",
      "managed Calendar caller cancellation rejects a pre-aborted caller before discovery or broker reads",
      "managed Calendar caller cancellation inherits cancellation from the active agent turn",
      "managed Calendar caller cancellation aborts managed discovery without reporting a failed source or starting feeds",
      "managed Calendar caller cancellation cancels in-flight and queued feeds without admitting later reads",
      "managed Calendar caller cancellation removes a cancelled request while another request holds every permit",
      "managed Calendar caller cancellation removes queued reads after a local failure while another request holds permits",
      "propagates return-shape cancellation to real managed HTTP feed requests",
      "propagates legacy-http cancellation to real managed HTTP feed requests",
    ],
  },
  {
    file: "src/service/managed-calendar-read-diagnostic.test.ts",
    label: "cache",
    names: [
      "owner-only managed Calendar read diagnostics retains HTTP rejection failure semantics and exposes only closed owner HTTP fields",
      "owner-only managed Calendar read diagnostics retains authenticated read refusal failure semantics and exposes only closed owner HTTP fields",
      "owner-only managed Calendar read diagnostics retains missing body failure semantics and exposes only closed owner HTTP fields",
      "owner-only managed Calendar read diagnostics retains body limit failure semantics and exposes only closed owner HTTP fields",
      "owner-only managed Calendar read diagnostics retains non-object failure semantics and exposes only closed owner HTTP fields",
      "owner-only managed Calendar read diagnostics retains invalid sources failure semantics and exposes only closed owner HTTP fields",
      "owner-only managed Calendar read diagnostics classifies managed default reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics classifies managed ephemeral reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics classifies managed fatal reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics classifies invalid severity reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics classifies missing own severity reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics classifies severity accessor reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics classifies model failure reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics classifies unknown failure reporting without clearing failed source health",
      "owner-only managed Calendar read diagnostics joins handled-read reporting with private diagnostics while retaining partial health",
      "owner-only managed Calendar read diagnostics keeps a valid empty managed list and fresh local feed complete",
      "owner-only managed Calendar read diagnostics ignores a diagnostic header on a successful empty source list",
      "owner-only managed Calendar read diagnostics leaves configuration construction failures outside read-attempt diagnostics",
      "owner-only managed Calendar read diagnostics uses the actual shared codec and rejects noncanonical or unsafe header metadata",
      "owner-only managed Calendar read diagnostics reads only a matching 409 read header before cancellation; other operations/statuses ignore it",
      "owner-only managed Calendar read diagnostics ignores malformed and wrong-operation headers without changing the public refusal",
      "owner-only managed Calendar read diagnostics does not copy forged context and drops private metadata across ordinary serialization",
      "owner-only managed Calendar read diagnostics never invokes forged metadata or public diagnostic getters",
      "owner-only managed Calendar read diagnostics rejects forged metadata shape and broker provenance outside read HTTP 409",
      "owner-only managed Calendar read diagnostics does not let optional attachment failure replace a frozen domain error",
      "owner-only managed Calendar read diagnostics keeps concurrent source/feed attempt status separate",
      "owner-only managed Calendar read diagnostics preserves thrown transport identity and JSON parse error behavior",
      "owner-only managed Calendar read diagnostics does not add diagnostics to mutation or write-capability operations",
      "admits larger managed feeds while keeping feed and source response bounds",
      "keeps a managed feed event in the canonical store for selected-event reads",
      "does not retain a managed read that finishes after imported-data removal",
      "keeps an unrelated managed grant concurrent while a removal drains its own read",
      "does not cache a cancelled managed broker read or report it as a successful feed",
      "rejects a partial managed feed before it can enter the canonical store",
      "drains a cancelled managed cache write before acknowledging imported-data removal",
      "rejects a failed managed removal and permits a real-store retry without a false receipt",
      "keeps a managed cache row unchanged when another agent reads the same host identity",
      "keeps a managed cache row unchanged when another calendar returns the same host identity",
    ],
  },
];
for (const { file, label, names } of cases) {
  const report = path.join(directory, `${label}.json`);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
      ),
      "run",
      "--config",
      "vitest.config.ts",
      file,
      "--cache=false",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.signal,
    null,
    `Managed Calendar ${label} conformance interrupted`,
  );
  assert.equal(
    result.status,
    0,
    `Managed Calendar ${label} conformance failed`,
  );
  requireVitestConformance(
    JSON.parse(readFileSync(report, "utf8")),
    fileURLToPath(new URL(`../${file}`, import.meta.url)),
    names,
  );
}
console.log(
  `56 exact managed Calendar implementation cases passed without skips. Evidence ${directory}`,
);
