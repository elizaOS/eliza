// The explore stage (SPEC.md, "Exploring the page"): Bombadil drives the package's page in Chromium, as its app script
// serves it, and checks the properties of test/bombadil.ts, or Bombadil's defaults, on every state it reaches.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { installedPackages } from "./action.ts";
import { bin, exec, startGroup } from "./run.ts";
import { profile, type TestProfile } from "./testing/profile.ts";
import { appScript, COLOUR, filesUnder, indent, packageManager, servedAt, testInputs, type Remember, type Reported } from "./util.ts";

const SPECIFICATION = "test/bombadil.ts";
const SAVED = "test/__traces__/bombadil";
/** The platforms the Bombadil package has an executable for. */
const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64"];
/** How long an app script may take to print the address it serves at: some build before they serve. */
const SAYS_WHERE_WITHIN = 300_000;

export type Explored =
  | { kind: "held"; actions: number }
  | { kind: "broke"; properties: string[]; report: string }
  | { kind: "diverged"; output: string }
  | { kind: "failed"; why: string; output: string };

/** The package's page: an index.html at its top or under src/. */
const pageOf = (root: string) => ["index.html", ...filesUnder(root, "src")].find((f) => /(?:^|\/)index\.html$/.test(f) && fs.existsSync(path.join(root, f)));

/**
 * What a run of Bombadil found, from its exit status and what it printed: an exploration that took no action held
 * nothing, and a replay that could not follow its trace has diverged from the page.
 */
export function explored(status: number, stdout: string, stderr: string, replay: boolean): Explored {
  const lines = `${stdout}\n${stderr}`.replace(COLOUR, "").split("\n");
  const actions = lines.filter((l) => /^\d\d:\d\d\.\d{3} /.test(l));
  const tail = lines.filter((l) => l.trim()).slice(-40).join("\n");
  if (status === 0 && (replay || actions.length)) return { kind: "held", actions: actions.length };
  if (status === 0) return { kind: "failed", why: "Bombadil took no action: Chrome took the whole time to start, or the page never settled between actions", output: tail };
  const properties = lines.flatMap((l) => l.match(/^(\S+) was violated:$/)?.slice(1) ?? []);
  if (status === 2 && properties.length) {
    const from = lines.findIndex((l) => / was violated:$/.test(l));
    const to = lines.findIndex((l, i) => i > from && /^(?:Test|Reproduction) finished/.test(l));
    const violations = lines.slice(from, to < 0 ? undefined : to).join("\n").trim();
    const last = actions.slice(-15);
    const before = actions.length > last.length ? [`… ${actions.length - last.length} actions before these`] : [];
    return { kind: "broke", properties, report: [...before, ...last, ...last.length ? [""] : [], violations].join("\n") };
  }
  if (/failed to locate chromium/.test(tail)) return { kind: "failed", why: "Bombadil found no Chromium: run `pnpm exec playwright install chromium`, or set CHROME to a Chrome or Chromium executable", output: tail };
  if (replay && /reproduction and original test diverged!/.test(tail)) return { kind: "diverged", output: tail };
  return { kind: "failed", why: /stalled/i.test(tail) ? "the browser stalled while Bombadil explored the page" : `Bombadil could not ${replay ? "replay the trace" : "explore the page"} (exit ${status})`, output: tail };
}

/** Playwright's Chromium for Bombadil, unless CHROME names a browser already; without either, Bombadil looks for Chrome itself. */
async function chromium(): Promise<NodeJS.ProcessEnv> {
  if (process.env.CHROME) return {};
  try {
    const executable = (await import("playwright")).chromium.executablePath();
    return fs.existsSync(executable) ? { CHROME: executable } : {};
  } catch {
    return {};
  }
}

/** One `bombadil browser test` of `origin`: a bounded exploration, or the replay of a saved trace. */
async function bombadil(root: string, origin: string, how: { seconds: number } | { reproduce: string }, output: string): Promise<Explored> {
  const specification = fs.existsSync(path.join(root, SPECIFICATION)) ? [SPECIFICATION] : [];
  const args = ["browser", "test", origin, ...specification, "--headless", "--no-sandbox", "--instrument-javascript=", "--output-path", output, "--output-path-overwrite",
    ...("seconds" in how ? ["--time-limit", `${how.seconds}s`, "--exit-on-violation"] : ["--reproduce", how.reproduce])];
  const r = await exec(bin("bombadil", root), args, root, { ...process.env, NO_COLOR: "1", ...await chromium() });
  return r.stopped ? { kind: "failed", why: r.stopped, output: `${r.stdout}${r.stderr}`.trim().split("\n").slice(-40).join("\n") } : explored(r.status, r.stdout, r.stderr, "reproduce" in how);
}

/** Run the package's app script until it prints its address, explore what it serves there, and stop it. */
async function served(root: string, script: string, checking: string, explore: (origin: string) => Promise<Explored>): Promise<Explored> {
  const command = `${packageManager(root).name} run ${script}`;
  const app = startGroup(command, root, { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none", SPEC_TESTS: checking });
  app.child.stdin.end();
  const said: string[] = [];
  let error: Error | undefined;
  try {
    const origin = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), SAYS_WHERE_WITHIN);
      app.child.on("error", (e) => { error = e; });
      for (const stream of [app.child.stdout, app.child.stderr]) readline.createInterface({ input: stream }).on("line", (line) => {
        if (line.trim() && said.push(line) > 40) said.shift();
        const at = servedAt(line);
        if (at) { clearTimeout(timer); resolve(at); }
      });
      void app.closed.then(() => { clearTimeout(timer); resolve(undefined); });
    });
    if (!origin) return { kind: "failed", why: `\`${command}\` printed no http://localhost address ${error ? `(${error.message})` : app.child.exitCode === null ? `within ${SAYS_WHERE_WITHIN / 1000} s` : "before it ended"}`, output: said.join("\n") };
    return await explore(origin);
  } finally {
    await app.stop();
  }
}

/**
 * The explore stage of the package `directory`, checked from `checking`: nothing if it has no page. A trace saved by
 * an earlier failure is replayed first; then the page is explored for the profile's time. A pass is remembered until
 * what the page serves, the installed Bombadil or the script change.
 */
export async function explore(directory: string, remember: Remember, mode: TestProfile = "normal", checking = directory): Promise<Reported<"explore" | "skipped">[]> {
  const root = path.resolve(directory);
  const page = pageOf(root);
  if (!page) return [];
  const platform = `${process.platform}-${process.arch}`;
  if (!PLATFORMS.includes(platform)) return [[true, "skipped", `explore of ${page}: Bombadil runs on ${PLATFORMS.join(", ")}, not ${platform}; CI explores it`]];
  const script = appScript(root);
  if (!script) return [[false, "explore", `${page} is a page, and package.json has no start or dev script that serves it: add one that prints the address it serves at`, "", page]];
  const saved = path.join(root, SAVED);
  const command = `${packageManager(root).name} run ${script}`;
  const specification = fs.existsSync(path.join(root, SPECIFICATION)) ? SPECIFICATION : "Bombadil's defaults";
  const broke = (r: Extract<Explored, { kind: "broke" }>, how: string): Reported<"explore"> => [false, "explore", `${page}: the page ${how} ${r.properties.join(", ")} (${command})`,
    indent(`${r.report}\n\nSaved as ${SAVED}, which is replayed first from now on; \`pnpm exec bombadil browser inspect ${SAVED}\` shows each state.`), page];
  const failed = (r: Extract<Explored, { kind: "failed" }>): Reported<"explore"> => [false, "explore", `${page}: ${r.why}`, indent(r.output), page];
  /** The saved trace, and test/__traces__/ and test/ if that leaves them empty. */
  const drop = () => {
    fs.rmSync(saved, { recursive: true, force: true });
    for (const dir of [path.dirname(saved), path.dirname(path.dirname(saved))]) if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  };
  const resolved = fs.realpathSync(path.resolve(checking));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spec-explore-"));
  try {
    const results: Reported<"explore">[] = [];
    if (fs.existsSync(saved)) {
      const again = await served(root, script, resolved, (origin) => bombadil(root, origin, { reproduce: saved }, path.join(scratch, "replay")));
      if (again.kind === "broke") return [broke(again, `still breaks, in the replay of ${SAVED},`)];
      if (again.kind === "failed") return [failed({ ...again, why: `${again.why}; ${SAVED} is kept, to be replayed when it can be` })];
      drop();
      results.push([true, "explore", `${page}: the replay of ${SAVED} ${again.kind === "held" ? "breaks nothing now" : "no longer applies to the page"}, so it was removed`, "", page]);
    }
    const { explore: seconds } = profile(mode);
    const explorer = installedPackages(bin("bombadil", root), "@antithesishq/bombadil");
    results.push(await remember(JSON.stringify([testInputs(root, mode, "page"), explorer, script]), async (): Promise<Reported<"explore">> => {
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      const fresh = await served(root, script, resolved, (origin) => bombadil(root, origin, { seconds }, saved));
      if (fresh.kind !== "broke") drop();
      return fresh.kind === "held" ? [true, "explore", `${page}: ${fresh.actions} actions in ${seconds} s broke no property of ${specification} (${command})`, "", page]
        : fresh.kind === "broke" ? broke(fresh, "breaks")
        : failed(fresh.kind === "failed" ? fresh : { kind: "failed", why: "Bombadil could not explore the page", output: fresh.output });
    }, ([ok]) => ok));
    return results;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
