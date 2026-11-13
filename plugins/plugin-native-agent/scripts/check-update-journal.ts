/** Compares Quint transitions with all real JVM journal conformance cases. */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

type Journal = {
  phase: string;
  reason: string;
  plan: number;
  base: number;
  session: number;
  attempts: number;
  gen: number;
  q: number[];
  reported: string;
  released: number;
  releases: number;
};
type Event = {
  kind: string;
  plan: number;
  base: number;
  installed: number;
  generation: number;
  session: number;
  pending: boolean;
  blocked: string;
  outcome: string;
  failure: string;
};
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function decode(value: Json): Json {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("#set" in value) return (value["#set"] as Json[]).map(decode);
  if ("#bigint" in value) return Number(value["#bigint"]);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decode(item)]),
  );
}

function journal(key: string): Journal {
  const [
    phase,
    reason,
    plan,
    base,
    session,
    attempts,
    gen,
    q,
    reported,
    releases,
  ] = key.split("|");
  if (!releases) throw new Error("Incomplete Java journal observation");
  const [released, count] = releases.split("x");
  return {
    phase,
    reason,
    plan: Number(plan),
    base: Number(base),
    session: Number(session),
    attempts: Number(attempts),
    gen: Number(gen),
    q: JSON.parse(q) as number[],
    reported: reported === "null" ? "none" : reported,
    released: Number(released),
    releases: Number(count),
  };
}

function key(value: Journal): string {
  if (value.phase === "REFUSED") return "REFUSED";
  const quarantine = `[${[...value.q].sort((a, b) => a - b).join(", ")}]`;
  return [
    value.phase,
    value.reason,
    value.plan,
    value.base,
    value.session,
    value.attempts,
    value.gen,
    quarantine,
    value.reported === "none" ? "null" : value.reported,
    `${value.released}x${value.releases}`,
  ].join("|");
}

function quintRecord(value: Journal | Event): string {
  return `{${Object.entries(value)
    .map(([field, item]) => {
      const encoded = Array.isArray(item)
        ? `Set(${item.join(",")})`
        : JSON.stringify(item);
      return `${field}: ${encoded}`;
    })
    .join(", ")}}`;
}

const adapter = `package ai.eliza.plugins.agent.updater;
import java.io.IOException;
import java.util.List;
public final class UpdateJournalQuint {
  static UpdateJournal setup(List<UpdateJournalConformanceTest.Event> recipe) throws IOException {
    UpdateJournal journal = new UpdateJournal(new UpdateJournalConformanceTest.MemoryStore());
    for (var event : recipe) UpdateJournalConformanceTest.apply(journal, event);
    return journal;
  }
  public static void main(String[] args) throws Exception {
    var recipes = UpdateJournalConformanceTest.recipes();
    var events = UpdateJournalConformanceTest.events();
    for (int index = 0; index < events.size(); index++) {
      var event = events.get(index);
      System.out.println("EVENT\\t" + index + "\\t" + event.kind() + "\\t" + event.plan()
        + "\\t" + event.base() + "\\t" + event.installed() + "\\t" + event.generation()
        + "\\t" + event.session() + "\\t" + event.pending() + "\\t" + event.blocked()
        + "\\t" + event.outcome() + "\\t" + event.failure());
    }
    int row = 0;
    for (var recipe : recipes.values()) {
      System.out.println("STATE\\t" + row + "\\t"
        + UpdateJournalConformanceTest.observed(setup(recipe).read()).key());
      for (int column = 0; column < events.size(); column++) {
        UpdateJournal journal = setup(recipe);
        String result;
        try {
          UpdateJournalConformanceTest.apply(journal, events.get(column));
          result = UpdateJournalConformanceTest.observed(journal.read()).key();
        } catch (IOException | IllegalArgumentException refused) {
          result = "REFUSED";
        }
        System.out.println("NEXT\\t" + row + "\\t" + column + "\\t" + result);
      }
      row++;
    }
  }
}
`;

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(
  process.argv[2] ??
    path.join(root, "plugins/plugin-native-agent/quint/UpdateJournal.qnt"),
);
const packageRoot = path.join(root, "plugins/plugin-native-agent");
const output = testOutputPath("quint", "update-journal-conformance");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(output, "run-"));
const java = (name: string) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
try {
  const adapterFile = path.join(temporary, "UpdateJournalQuint.java");
  writeFileSync(adapterFile, adapter);
  execFileSync(
    java("javac"),
    [
      "-d",
      temporary,
      path.join(
        packageRoot,
        "android/src/main/java/ai/eliza/plugins/agent/updater/UpdateJournal.java",
      ),
      path.join(
        packageRoot,
        "test/native-host/UpdateJournalConformanceTest.java",
      ),
      adapterFile,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  const observations = execFileSync(
    java("java"),
    ["-cp", temporary, "ai.eliza.plugins.agent.updater.UpdateJournalQuint"],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  writeFileSync(path.join(output, "java-observations.tsv"), observations);
  const states: Journal[] = [];
  const events: Event[] = [];
  const expected = new Map<string, string>();
  for (const line of observations.trimEnd().split(/\r?\n/)) {
    const [kind, row, ...fields] = line.split("\t");
    if (kind === "STATE") states[Number(row)] = journal(fields[0]);
    else if (kind === "EVENT") {
      const [
        kind,
        plan,
        base,
        installed,
        generation,
        session,
        pending,
        blocked,
        outcome,
        failure,
      ] = fields;
      events[Number(row)] = {
        kind,
        plan: Number(plan),
        base: Number(base),
        installed: Number(installed),
        generation: Number(generation),
        session: Number(session),
        pending: pending === "true",
        blocked: blocked === "null" ? "none" : blocked,
        outcome,
        failure: failure === "null" ? "none" : failure,
      };
    } else if (kind === "NEXT") expected.set(`${row}/${fields[0]}`, fields[1]);
    else throw new Error(`Unknown JVM observation kind ${kind}`);
  }
  if (
    states.length !== 37 ||
    events.length !== 313 ||
    expected.size !== 11_581
  ) {
    throw new Error(
      `Unexpected JVM case table ${states.length} × ${events.length}`,
    );
  }
  const importPath = path
    .relative(temporary, model)
    .replaceAll(path.sep, "/")
    .replace(/\.qnt$/, "");
  const driver = `module UpdateJournalConformance {
  import UpdateJournal.* from ${JSON.stringify(importPath)}
  pure val inputs = List(${states.map(quintRecord).join(",\n")})
  pure val events = List(${events.map(quintRecord).join(",\n")})
  var index: int
  var results: List[Journal]
  action tableInit = all { s' = empty, index' = 0, results' = List() }
  action tableStep = all { s' = s, if (index < inputs.length()) all {
    results' = events.foldl(List(), (row, e) => row.append(stepJournal(inputs.nth(index), e))),
    index' = index + 1
  } else all { results' = results, index' = index } }
}`;
  const driverFile = path.join(temporary, "UpdateJournalConformance.qnt");
  writeFileSync(driverFile, driver);
  const require = createRequire(path.join(root, "package.json"));
  const quintPackage = require.resolve("@informalsystems/quint/package.json");
  const installed = JSON.parse(readFileSync(quintPackage, "utf8")) as {
    version: string;
    bin: { quint: string };
  };
  if (installed.version !== "0.33.1")
    throw new Error("Quint 0.33.1 is required");
  const traceFile = path.join(temporary, "quint-table.itf.json");
  const quintOutput = execFileSync(
    process.execPath,
    [
      path.resolve(path.dirname(quintPackage), installed.bin.quint),
      "run",
      driverFile,
      "--main",
      "UpdateJournalConformance",
      "--init",
      "tableInit",
      "--step",
      "tableStep",
      "--max-steps",
      String(states.length),
      "--max-samples",
      "1",
      "--seed",
      "1",
      "--backend",
      "typescript",
      "--out-itf",
      traceFile,
    ],
    {
      cwd: temporary,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  writeFileSync(path.join(output, "quint.log"), quintOutput);
  const traceText = readFileSync(traceFile, "utf8");
  writeFileSync(path.join(output, "quint-table.itf.json"), traceText);
  const trace = JSON.parse(traceText) as {
    states: Json[];
  };
  const checked = new Set<string>();
  for (const encoded of trace.states.slice(1)) {
    const state = decode(encoded) as { index: number; results: Journal[] };
    const row = state.index - 1;
    if (state.results.length !== events.length)
      throw new Error(`Incomplete Quint row ${row}`);
    for (const [column, result] of state.results.entries()) {
      const caseId = `${row}/${column}`;
      if (checked.has(caseId))
        throw new Error(`Duplicate Quint case ${caseId}`);
      checked.add(caseId);
      const actual = expected.get(caseId);
      if (key(result) !== actual)
        throw new Error(
          `Quint/JVM mismatch at ${row}/${column}: ${key(result)} != ${actual}`,
        );
    }
  }
  if (checked.size !== expected.size)
    throw new Error(`Quint checked ${checked.size} of ${expected.size} cases`);
  console.log(
    `UpdateJournal Quint/JVM conformance: ${checked.size} cases, zero differences`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
