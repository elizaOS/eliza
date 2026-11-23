import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { LIB_FILE } from "../prove.ts";
import { bin, exec } from "../run.ts";
import { scanSpec } from "../scan.ts";
import { filesUnder } from "../util.ts";
import { exampleCheckKeys } from "./examples.ts";
import { PACKED, toolShards } from "./tools.ts";

const project = path.resolve(import.meta.dirname, "../..");
const read = (file: string, from = project): string => fs.readFileSync(path.join(from, file), "utf8");
const toolSource = "vibestack/selftest.ts";
const docsSource = "vibestack/selftests/docs.ts";
const examplesSource = "vibestack/selftests/examples.ts";
const toolMetadata = "vibestack/selftests/tools.ts";
const EXAMPLES = "vibestack/examples";

describe("the documents name what exists", () => {
  const DOCS = ["AGENTS.md", "SPEC.md", "README.md", "CONTRIBUTING.md", ...filesUnder(project, ".agents/skills").filter((file) => file.endsWith(".md"))];
  const manifest = (dir: string): Record<string, Record<string, string> | undefined> => JSON.parse(read(path.join(dir, "package.json")));
  const within = (dir: string) => fs.existsSync(path.join(project, dir)) ? fs.readdirSync(path.join(project, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${dir}/${e.name}`) : [];

  test("every repository path, pnpm script and link in the documents and skills leads somewhere", () => {
    // What pnpm itself provides, and what a document proposes rather than names.
    const scripts = new Set(["install", "exec", "add", "pack", ...["", "vibestack/studio", ...["packages", "apps", "vibestack/examples"].flatMap(within)].flatMap((dir) => Object.keys(manifest(dir).scripts ?? {}))]);
    const proposed = ["apps/billing", "packages/billing", "vibestack/README.md", "vibestack/LICENSE"];
    // A heading as GitHub links to it.
    const anchors = (file: string) => read(file).split("\n").flatMap((line) => /^#{1,6} /.test(line) ? [line.replace(/^#+ /, "").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-")] : []);
    const lost = DOCS.flatMap((doc) => {
      const lines = scanSpec(read(doc));
      const prose = lines.filter((line) => ["story", "rule", "prose"].includes(line.kind)).map((line) => line.text);
      const code = [...lines.filter((line) => ["quint", "fenced"].includes(line.kind)).map((line) => line.text), ...prose.flatMap((line) => [...line.matchAll(/(`+)(.+?)\1/g)].map((m) => m[2]))];
      const links = [...prose.join("\n").replace(/(`+).+?\1/g, "").matchAll(/\]\((?!https?:)([^)#\s]*)(?:#([^)\s]*))?\)/g)].filter(([, file, anchor]) => {
        const target = file ? path.join(path.dirname(doc), file) : doc;
        return !fs.existsSync(path.join(project, target)) || (anchor && !anchors(target).includes(anchor));
      }).map((m) => m[0]);
      // gen/ and generated/ are written by the tools, so a fresh checkout has none; vibestack/gen/ is the translator's source.
      const paths = code.flatMap((span) => [...span.matchAll(/(?<![\w./-])((?:vibestack|docs|packages|apps|\.github|\.agents|\.claude)\/[\w./@-]*)(?![\w<*{…])/g)].map((m) => m[1].replace(/[.:]+$/, "")))
        .filter((file) => !fs.existsSync(path.join(project, file)) && !proposed.includes(file) && !/^(?!vibestack\/gen\/).*\/(gen|generated)(\/|$)/.test(file));
      const commands = code.flatMap((span) => [...span.matchAll(/\bpnpm ([a-z][\w:-]*)/g)].map((m) => m[1])).filter((script) => !scripts.has(script)).map((script) => `pnpm ${script}`);
      return [...links, ...paths, ...commands].map((what) => `${doc}: ${what}`);
    });
    assert.deepEqual([...new Set(lost)], []);
  });

  test("the prove skill lists everything the proof library declares", () => {
    const skill = read(".agents/skills/prove/SKILL.md");
    const declared = [...fs.readFileSync(LIB_FILE, "utf8").matchAll(/^\s*(?:ghost )?(?:lemma|function|predicate) (\w+)/gm)].map((m) => m[1]);
    assert.ok(declared.length > 30, "vibestack/proof/lib.dfy declares its lemmas one to a line");
    assert.deepEqual(declared.filter((name) => !skill.includes(`\`${name}\``)), []);
  });

  test("each example pins Effect, VibeLang, Vite and Vitest where the tools do", () => {
    const pins = (dir: string) => Object.entries({ ...manifest(dir).dependencies, ...manifest(dir).devDependencies }).filter(([name]) => /^(@effect\/.+|effect|vibelang.*|vite|vitest)$/.test(name));
    const root = Object.fromEntries(pins(""));
    assert.deepEqual(within("vibestack/examples").flatMap((dir) => pins(dir).filter(([name, version]) => root[name] !== version).map(([name, version]) => `${dir}: ${name} ${version}, the tools ${root[name]}`)), []);
  });

  test("each selftest task is cached by what its tests read: the documents by every file they can name, the examples by theirs and the tools, the rest by all but the other examples; no workspace task by the selftest; every test runs in exactly one task, a new one in the rest, and each task of verify in exactly one job of CI", async () => {
    const turbo = bin("turbo", project);
    const { scripts }: { scripts: Record<string, string> } = JSON.parse(read("package.json"));
    const listed = (script: string) => scripts[script].split(" ").slice(3);
    const selftests = Object.keys(scripts).filter((script) => script.startsWith("selftest:")).sort();
    const shards = selftests.filter((script) => script.startsWith("selftest:tools:"));
    const dry = await exec(turbo, ["run", ...listed("selftest"), "--dry=json"], project, { ...process.env, TURBO_TELEMETRY_DISABLED: "1" });
    assert.equal(dry.status, 0, dry.stderr);
    const plan: { globalCacheInputs: { files: Record<string, string> }; tasks: { taskId: string; inputs: Record<string, string> }[] } = JSON.parse(dry.stdout);
    const global = Object.keys(plan.globalCacheInputs.files);
    const [docs, examples, ...tools] = ["selftest:docs", "selftest:examples", ...shards].map((task) => new Set([...global, ...Object.keys(plan.tasks.find((t) => t.taskId === `//#${task}`)!.inputs)]));
    const tracked = (await exec("git", ["ls-files"], project)).stdout.trim().split("\n").filter((file) => fs.lstatSync(path.join(project, file)).isFile());
    const missed = (hashed: Set<string>, read: (file: string) => boolean) => tracked.filter((file) => read(file) && !hashed.has(file));
    const workspace = (file: string) => /^(apps|packages|spec)\//.test(file);
    const [shardA, shardB, packed] = tools;
    const toolInput = (file: string) => ![docsSource, examplesSource].includes(file)
      && (PACKED.includes(file) || /^(vibestack\/(?!examples\/)|vibestack\/examples\/order\/|\.agents\/skills\/)/.test(file));
    assert.deepEqual({
      docs: missed(docs, () => true),
      examples: missed(examples, (file) => ![toolSource, docsSource, toolMetadata].includes(file) && /^vibestack\/(examples\/|(?!studio\/|fixtures\/|(testing|stories|design)\/test\/))/.test(file)),
      tools: tools.flatMap((hashed) => missed(hashed, (file) => toolInput(file) && (hashed === packed || file !== "README.md"))),
      packed: missed(packed, (file) => file === ".gitignore" || workspace(file)),
      readmeInFixtures: [shardA, shardB].some((hashed) => hashed.has("README.md")),
      workspaceInFixtures: [shardA, shardB].flatMap((hashed) => [...hashed].filter(workspace)),
      examplesInTools: tools.flatMap((hashed) => [...hashed]).filter((file) => /^vibestack\/examples\/(?!order\/)/.test(file)),
      selftestInGlobal: global.filter((file) => /^vibestack\/(selftest\.ts$|selftests\/|remote-cache\.ts$)|\/test\//.test(file)),
      independentSourcesInTools: tools.flatMap((hashed) => [docsSource, examplesSource].filter((file) => hashed.has(file))),
      independentSourcesInExamples: [toolSource, docsSource, toolMetadata].filter((file) => examples.has(file)),
    }, { docs: [], examples: [], tools: [], packed: [], readmeInFixtures: false, workspaceInFixtures: [], examplesInTools: [], selftestInGlobal: [], independentSourcesInTools: [], independentSourcesInExamples: [] });
    assert.deepEqual([shards, listed("selftest").sort(), listed("verify").filter((task) => task.includes("selftest")).sort()],
      [["selftest:tools:a", "selftest:tools:b", "selftest:tools:rest"], selftests.map((task) => `//#${task}`), selftests.map((task) => `//#${task}`)], "pnpm selftest and pnpm verify run every selftest task");
    const each = "the tools each check catches its own kind of mistake";
    const inShards = Object.fromEntries(Object.entries(toolShards).map(([id, shard]) => [`${each} ${shard}`, `selftest:tools:${id}`]));
    const toolText = read(toolSource);
    const registered = toolText.split(/^function /m)
      .filter((block) => /^eachCheck[AB]?\(\)/.test(block))
      .flatMap((block) => [...block.matchAll(/^  test\("([^"]+)"/gm)].map(([, title]) => title));
    assert.deepEqual(registered.filter((title, index) => registered.indexOf(title) !== index), [], "each check fixture is registered once");
    const titles = (source: string) => [...source.matchAll(/^(?:if \(import\.meta\.main\) )?(?:describe|test)\("([^"]+)"/gm)].map(([, title]) => title);
    const toolTitles = [...titles(toolText), ...Object.keys(inShards), "a new test", "the tools a new suite",
      "the tools the command line and what a failed proof leaves to start from a new test", `${each} a new test`];
    const docsTitle = "the documents name what exists";
    const examplesTitle = "the standalone examples";
    assert.deepEqual(titles(read(docsSource)), [docsTitle]);
    assert.deepEqual(titles(read(examplesSource)), [examplesTitle]);
    assert.ok(toolTitles.every((title) => title !== docsTitle && title !== examplesTitle));
    const selectors = selftests.map((task) => {
      const parsed = scripts[task].match(/^node --test --test-(name|skip)-pattern="([^"]+)" (\S+)$/);
      assert.ok(parsed, task);
      const [, kind, pattern, file] = parsed;
      return { task, kind, pattern: new RegExp(pattern), file };
    });
    const ranBy = (file: string, title: string) => selectors.filter((selector) =>
      selector.file === file && selector.pattern.test(`${title} `) === (selector.kind === "name")).map(({ task }) => task);
    assert.deepEqual(ranBy(docsSource, docsTitle), ["selftest:docs"]);
    assert.deepEqual(ranBy(examplesSource, examplesTitle), ["selftest:examples"]);
    assert.deepEqual(toolTitles.map((title) => [title, ranBy(toolSource, title)]),
      toolTitles.map((title) => [title, [inShards[title] ?? "selftest:tools:rest"]]));
    const jobs = [...read(".github/workflows/ci.yml").matchAll(/^ +tasks: (.+)$/gm)].flatMap(([, tasks]) => tasks.split(" "));
    assert.deepEqual(jobs.sort(), listed("verify").sort(), "CI's jobs run the tasks of pnpm verify between them, each once");
    const release = read(".github/workflows/release.yml");
    assert.match(release, /^ +- run: pnpm selftest --only --concurrency=1$/m);
    const releasePrerequisites = release.match(/^ +- run: pnpm all (.+) --concurrency=1$/m)?.[1].split(" ").sort();
    assert.match(scripts.prepare, /^node vibestack\/spec\.ts gen --install --skip-gen-on-pack \/\/#build(?: |$)/);
    assert.deepEqual(["//#build", ...releasePrerequisites ?? []].sort(), JSON.parse(read("turbo.json")).tasks["//#selftest:tools:a"].dependsOn.toSorted(), "pack and the release tasks materialize every prerequisite before using the isolated CI shard cache");
    assert.deepEqual(read(".github/workflows/fuzz.yml").match(/^ +shard: \[(.+)\]$/m)?.[1].split(", "), shards.map((task) => task.split(":")[2]), "the nightly run names every shard");
    const [first, ...others] = shards.map((task) => JSON.parse(read("turbo.json")).tasks[`//#${task}`].dependsOn);
    assert.deepEqual(others, others.map(() => first), "the shards wait for the same integration prerequisites");
    assert.deepEqual(fs.readdirSync(path.join(project, ".github/workflows")).filter((flow) => /\bdevelop\b/.test(read(`.github/workflows/${flow}`).replace(/^ +branches: \[[\w, ]+\]$/gm, ""))), [], "develop is named only where a workflow lists the branches that trigger it");
  });

  test("tasks wait for the root's gen where needed; selftest edits keep the CLI build cached, and Studio only reacts to its inputs", async (context) => {
    const scripts = { build: "true", typecheck: "true", test: 'node -p "process.env.QUINT_HOME"', "test:browser": "true" };
    const turbo = bin("turbo", project);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spec-docs-selftest-")));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "spec/kit"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/kit"), { recursive: true });
    fs.writeFileSync(path.join(root, "spec/kit/index.md"), "# Kit\n");
    fs.writeFileSync(path.join(root, "packages/kit/package.json"), JSON.stringify({ name: "@repo/kit", scripts }));
    for (const file of (await exec("git", ["ls-files"], project)).stdout.trim().split("\n")) {
      if (fs.lstatSync(path.join(project, file)).isDirectory()) continue;
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.cpSync(path.join(project, file), path.join(root, file), { verbatimSymlinks: true });
    }
    await exec("git", ["init", "-q"], root);
    const evaluatorHome = path.join(root, "custom quint home");
    const child = await exec(turbo, ["run", "@repo/kit#test", "--only", "--env-mode=strict", "--cache=local:rw", "--output-logs=full"], root,
      { ...process.env, QUINT_HOME: evaluatorHome, TURBO_TELEMETRY_DISABLED: "1" });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(child.stdout.includes(evaluatorHome), child.stdout);
    const plan = async () => {
      const dry = await exec(turbo, ["run", "build", "typecheck", "test", "test:browser", "vibestack-studio#dev", "//#lint:js", "//#lint:css", "//#analyze", "//#selftest:tools:a", "//#selftest:tools:b", "//#selftest:tools:rest", "//#selftest:docs", "//#selftest:examples", "--dry=json"], root, { ...process.env, TURBO_TELEMETRY_DISABLED: "1" });
      assert.equal(dry.status, 0, dry.stderr);
      const tasks: { taskId: string; hash: string; command: string; dependencies: string[]; inputs: Record<string, string> }[] = JSON.parse(dry.stdout).tasks;
      return new Map(tasks.map((task) => [task.taskId, task]));
    };
    const tasks = await plan();
    const reach = (id: string, seen = new Set<string>()): Set<string> => {
      for (const dependency of tasks.get(id)!.dependencies) if (!seen.has(dependency)) reach(dependency, seen.add(dependency));
      return seen;
    };
    const real = [...tasks.values()].filter((task) => task.command !== "<NONEXISTENT>" && !task.taskId.endsWith("#gen")).map((task) => task.taskId);
    let previousPlan = tasks;
    const changedBy = async (edit: () => void | Promise<void>) => {
      const before = previousPlan;
      await edit();
      previousPlan = await plan();
      return [...previousPlan].filter(([id, task]) => before.get(id)?.hash !== task.hash).map(([id]) => id).sort();
    };
    const studio = (ids: string[]) => ids.filter((id) => /^(vibestack-studio#(?!check)|@repo\/(ui#(build|typecheck)|design-system#build)|\/\/#lint:css)/.test(id));
    const append = (file: string, text = "\nMore words.\n") => () => fs.appendFileSync(path.join(root, file), text);
    const vibeDeclared = ["apps/app", "packages/ui", "vibestack/studio"].filter((dir) => read(`${dir}/tsconfig.json`, root).includes(".vibe/declarations")).map((dir) => `${JSON.parse(read(`${dir}/package.json`, root)).name}#typecheck`);
    const [prose, selftest, fixture, frameworkTest] = [
      await changedBy(append("spec/app/index.md")),
      await changedBy(append(toolSource, "\n")),
      await changedBy(append("vibestack/fixtures/door.md")),
      await changedBy(append("vibestack/design/test/design.test.ts", "\n")),
    ];
    const selftests = (ids: string[]) => ids.filter((id) => /^\/\/#(?:selftest:|build$|test$)/.test(id));
    assert.deepEqual(selftests(await changedBy(append(docsSource, "\n"))), ["//#selftest:docs"]);
    assert.deepEqual(selftests(await changedBy(append(examplesSource, "\n"))), ["//#selftest:docs", "//#selftest:examples"]);
    let previousExampleKeys = await exampleCheckKeys(root, turbo);
    const examplesChangedBy = async (edit: () => void) => {
      const before = previousExampleKeys;
      edit();
      previousExampleKeys = await exampleCheckKeys(root, turbo);
      return [...previousExampleKeys].filter(([name, key]) => before.get(name) !== key).map(([name]) => name).sort();
    };
    const order = path.join(EXAMPLES, "order");
    const exampleChanges = [
      await examplesChangedBy(append(toolSource, "\n")),
      await examplesChangedBy(append(docsSource, "\n")),
      await examplesChangedBy(append(path.join(order, "src/app.vibe"), "\n")),
      await examplesChangedBy(append(path.join(order, "pnpm-lock.yaml"), "\n")),
      await examplesChangedBy(append("vibestack/run.ts", "\n")),
      await examplesChangedBy(append(examplesSource, "\n")),
    ];
    const exampleNames = fs.readdirSync(path.join(root, EXAMPLES)).sort();
    assert.deepEqual(exampleChanges, [[], [], ["order"], ["order"], exampleNames, exampleNames]);
    previousPlan = await plan();
    const readme = await changedBy(append("README.md"));
    assert.deepEqual({
      notWaiting: real.filter((id) => !reach(id).has("//#gen")).sort(),
      analyzeWaitsFor: tasks.get("//#analyze")!.dependencies.toSorted(),
      lintWaitsFor: vibeDeclared.filter((id) => tasks.get("//#lint:js")!.dependencies.includes(id)),
      devWaitsFor: tasks.get("vibestack-studio#dev")!.dependencies.toSorted(),
      prose: [studio(prose), prose.includes("@repo/app#test"), prose.includes("//#analyze")],
      readme: [selftests(readme), readme.includes("//#analyze")],
      selftest: [studio(selftest), selftest.includes("//#build"), ["a", "b", "rest"].every((shard) => selftest.includes(`//#selftest:tools:${shard}`))],
      fixture: { studio: studio(fixture), build: fixture.includes("//#build"), selftest: fixture.includes("//#selftest:tools:a") },
      frameworkTest: { build: frameworkTest.includes("//#build"), test: frameworkTest.includes("//#test") },
      independentOwner: (await changedBy(() => {
        fs.mkdirSync(path.join(root, "packages/kit/spec"));
        fs.writeFileSync(path.join(root, "packages/kit/spec/index.md"), "# Standalone kit\n");
      })).includes("//#gen"),
      leftovers: await changedBy(async () => {
        for (const dir of ["", "packages/ui/", "vibestack/fixtures/"]) fs.writeFileSync(path.join(root, `${dir}.DS_Store`), "\0");
        fs.mkdirSync(path.join(root, "packages/ui/.cache/vitest/attachments"), { recursive: true });
        fs.writeFileSync(path.join(root, "packages/ui/.cache/vitest/attachments/failed.png"), "\0");
        assert.equal((await exec("git", ["add", "-A"], root)).status, 0);
      }),
    }, {
      notWaiting: ["//#build", "//#lint:css", "//#selftest:docs", "//#selftest:examples", "@repo/design-system#build", "@repo/ui#typecheck", "vibestack-studio#build", "vibestack-studio#dev", "vibestack-studio#test", "vibestack-studio#typecheck"],
      analyzeWaitsFor: ["//#gen", "@repo/design-system#build", "@repo/ui#gen", "vibestack-studio#gen"],
      lintWaitsFor: vibeDeclared, devWaitsFor: tasks.get("vibestack-studio#build")!.dependencies.toSorted(), prose: [[], true, true], readme: [["//#selftest:docs", "//#selftest:tools:rest"], false], selftest: [[], false, true],
      fixture: { studio: ["vibestack-studio#test"], build: false, selftest: true },
      frameworkTest: { build: false, test: true },
      independentOwner: true, leftovers: [],
    }, "the owners' tasks, @repo/kit's among them, wait for the root's gen, and install's //#build does not, so `gen --if-valid` after it keeps a half-edited spec from failing install");
  });
});
