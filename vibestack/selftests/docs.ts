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

  const trackedEntries = async () => {
    const listed = await exec("git", ["ls-files", "--stage", "-z"], project);
    assert.equal(listed.status, 0, listed.stderr);
    return listed.stdout.split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, object] = entry.slice(0, tab).split(" ");
      return { mode, object, file: entry.slice(tab + 1) };
    });
  };

  test("every repository path, pnpm script and link in the documents and skills leads somewhere", () => {
    const workspace = ["packages", "apps"].flatMap(within).filter((dir) => fs.existsSync(path.join(project, dir, "package.json")));
    // What pnpm itself provides, and what a document proposes rather than names.
    const scripts = new Set(["install", "exec", "add", "pack", ...["", "vibestack/studio", ...workspace, ...within("vibestack/examples")].flatMap((dir) => Object.keys(manifest(dir).scripts ?? {}))]);
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
    const dry = await exec(turbo, ["run", ...listed("selftest"), "--dry=json", "--cache=local:w"], project, { ...process.env, TURBO_TELEMETRY_DISABLED: "1" });
    assert.equal(dry.status, 0, dry.stderr);
    const plan: { globalCacheInputs: { files: Record<string, string> }; tasks: { taskId: string; inputs: Record<string, string> }[] } = JSON.parse(dry.stdout);
    const global = Object.keys(plan.globalCacheInputs.files);
    const [docs, examples, ...tools] = ["selftest:docs", "selftest:examples", ...shards].map((task) => new Set([...global, ...Object.keys(plan.tasks.find((t) => t.taskId === `//#${task}`)!.inputs)]));
    const tracked = (await trackedEntries()).filter(({ mode, file }) =>
      mode !== "160000" && fs.lstatSync(path.join(project, file), { throwIfNoEntry: false })?.isFile()).map(({ file }) => file);
    const missed = (hashed: Set<string>, read: (file: string) => boolean) => tracked.filter((file) => read(file) && !hashed.has(file));
    const workspace = (file: string) => /^(apps|packages|spec)\//.test(file);
    const [shardA, shardB, packed] = tools;
    const toolInput = (file: string) => ![docsSource, examplesSource].includes(file)
      && ((!workspace(file) && PACKED.includes(file)) || /^(vibestack\/(?!examples\/)|vibestack\/examples\/order\/|\.agents\/skills\/)/.test(file));
    assert.deepEqual({
      docs: missed(docs, () => true),
      examples: missed(examples, (file) => ![toolSource, docsSource, toolMetadata].includes(file) && /^vibestack\/(examples\/|(?!studio\/|fixtures\/|(testing|stories|design)\/test\/))/.test(file)),
      tools: tools.flatMap((hashed) => missed(hashed, (file) => toolInput(file) && (hashed === packed || file !== "README.md"))),
      packed: missed(packed, (file) => file === ".gitignore" || PACKED.includes(file) || /^(packages|spec)\//.test(file)),
      unstagedAppFiles: [...packed].filter((file) => file.startsWith("apps/") && !PACKED.includes(file)),
      readmeInFixtures: [shardA, shardB].some((hashed) => hashed.has("README.md")),
      workspaceInFixtures: [shardA, shardB].flatMap((hashed) => [...hashed].filter(workspace)),
      examplesInTools: tools.flatMap((hashed) => [...hashed]).filter((file) => /^vibestack\/examples\/(?!order\/)/.test(file)),
      selftestInGlobal: global.filter((file) => /^vibestack\/(selftest\.ts$|selftests\/|remote-cache\.ts$)|\/test\//.test(file)),
      independentSourcesInTools: tools.flatMap((hashed) => [docsSource, examplesSource].filter((file) => hashed.has(file))),
      independentSourcesInExamples: [toolSource, docsSource, toolMetadata].filter((file) => examples.has(file)),
    }, { docs: [], examples: [], tools: [], packed: [], unstagedAppFiles: [], readmeInFixtures: false, workspaceInFixtures: [], examplesInTools: [], selftestInGlobal: [], independentSourcesInTools: [], independentSourcesInExamples: [] });
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
    const fuzz = read(".github/workflows/fuzz.yml");
    const nightly = fuzz.match(/^  vibestack-nightly-check:\n((?: {4}.*\n|\n)*)/m)?.[1] ?? "";
    assert.match(nightly, /^ +- run: pnpm all check --continue -- --nightly$/m);
    assert.deepEqual(fuzz.match(/^ +shard: \[(.+)\]$/m)?.[1].split(", "), shards.map((task) => task.split(":")[2]), "the nightly run names every shard");
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
    const initialized = await exec("git", ["init", "-q"], root);
    assert.equal(initialized.status, 0, initialized.stderr);
    for (const { mode, object, file } of await trackedEntries()) {
      const destination = path.join(root, file);
      if (mode === "160000") {
        fs.mkdirSync(destination, { recursive: true });
        const indexed = await exec("git", ["update-index", "--add", "--cacheinfo", mode, object, file], root);
        assert.equal(indexed.status, 0, indexed.stderr);
      } else if (fs.lstatSync(path.join(project, file), { throwIfNoEntry: false })) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(path.join(project, file), destination, { verbatimSymlinks: true });
      }
    }
    const staged = await exec("git", ["add", "-A"], root);
    assert.equal(staged.status, 0, staged.stderr);
    const evaluatorHome = path.join(root, "custom quint home");
    const child = await exec(turbo, ["run", "@repo/kit#test", "--only", "--env-mode=strict", "--cache=local:rw", "--output-logs=full"], root,
      { ...process.env, QUINT_HOME: evaluatorHome, TURBO_TELEMETRY_DISABLED: "1" });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(child.stdout.includes(evaluatorHome), child.stdout);
    const plan = async () => {
      const dry = await exec(turbo, ["run", "build", "typecheck", "test", "test:browser", "vibestack-studio#dev", "//#lint:js", "//#lint:css", "//#analyze", "//#selftest:tools:a", "//#selftest:tools:b", "//#selftest:tools:rest", "//#selftest:docs", "//#selftest:examples", "--dry=json", "--cache=local:w"], root, { ...process.env, TURBO_TELEMETRY_DISABLED: "1" });
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
    const vibeDeclared = [...["packages", "apps"].flatMap(within), "vibestack/studio"]
      .filter((dir) => fs.existsSync(path.join(root, dir, "tsconfig.json")) && read(`${dir}/tsconfig.json`, root).includes(".vibe/declarations"))
      .map((dir) => `${JSON.parse(read(`${dir}/package.json`, root)).name}#typecheck`);
    const [prose, selftest, fixture, frameworkTest] = [
      await changedBy(append("spec/kit/index.md")),
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
      prose: [studio(prose), prose.includes("@repo/kit#test"), prose.includes("//#analyze")],
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

    await context.test("legacy proof exclusions cannot preserve stale generation and build keys", () => verifyGenerationInputs(root));
  });
});

async function verifyGenerationInputs(root: string) {
  fs.rmSync(path.join(root, "packages/kit/spec"), { recursive: true });
  fs.symlinkSync(path.join(project, "node_modules"), path.join(root, "node_modules"), "dir");
  const generationPlan = async (options: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    const dry = await exec(process.execPath, [path.join(root, "vibestack/spec.ts"), "tasks", "//#gen", "@repo/kit#build", "//#lint:css", "--dry=json", "--cache=local:w", ...options], root, {
      ...process.env, TURBO_TOKEN: "", TURBO_ROOT_TURBO_JSON: undefined, GITHUB_ACTIONS: "true", GITHUB_JOB: "verify", GITHUB_WORKSPACE: root,
      GITHUB_REPOSITORY: "lalalune/vibestack", GITHUB_WORKFLOW_REF: "lalalune/vibestack/.github/workflows/ci.yml@refs/heads/main", ...env,
    });
    assert.equal(dry.status, 0, dry.stderr);
    const tasks: { taskId: string; hash: string; resolvedTaskDefinition: { cache: boolean; env: string[] } }[] = JSON.parse(dry.stdout).tasks;
    const generation = tasks.find(({ taskId }) => taskId === "//#gen");
    const build = tasks.find(({ taskId }) => taskId === "@repo/kit#build");
    const css = tasks.find(({ taskId }) => taskId === "//#lint:css");
    assert.ok(generation && build && css);
    assert.ok(build.resolvedTaskDefinition.cache);
    return { gen: generation.hash, build: build.hash, cssEnv: css.resolvedTaskDefinition.env };
  };
  const changed = (before: { gen: string; build: string }, after: { gen: string; build: string }, file: string) => {
    assert.notEqual(after.gen, before.gen, `generation key for ${file}`);
    assert.notEqual(after.build, before.build, `dependent build key for ${file}`);
  };

  const companion = path.join(root, "spec/kit/index.proof.dfy");
  fs.writeFileSync(companion, "lemma One() {}\n");
  const canonical = await generationPlan();
  fs.appendFileSync(companion, "lemma Two() {}\n");
  assert.deepEqual(await generationPlan(), canonical);
  fs.appendFileSync(path.join(root, "spec/kit/index.md"), "\nThis is still the kit.\n");
  changed(canonical, await generationPlan(), "spec/kit/index.md");

  const legacy = "legacy turbo.jsonc";
  const config = JSON.parse(read("turbo.json", root));
  config.tasks["//#gen"].inputs.push("!spec/**/*.proof.dfy");
  const customEnv = ["LEGACY_PROOF_TEST"];
  config.tasks["//#lint:css"].env = customEnv;
  const writeLegacyConfig = () => fs.writeFileSync(path.join(root, legacy), JSON.stringify(config).replace(/^{/, "{\n// The project selects this config.\n"));
  writeLegacyConfig();
  const selected = ["--root-turbo-json", legacy];
  const rootOnly = await generationPlan(selected);
  assert.deepEqual(rootOnly.cssEnv, customEnv);
  fs.appendFileSync(companion, "lemma Three() {}\n");
  assert.deepEqual(await generationPlan(selected), rootOnly);

  const standalone = path.join(root, "packages/kit/spec");
  fs.mkdirSync(standalone);
  changed(rootOnly, await generationPlan(selected), "empty packages/kit/spec with only the root proof exclusion");
  fs.rmdirSync(standalone);
  assert.deepEqual(await generationPlan(selected), rootOnly);

  config.tasks["//#gen"].inputs.push("!apps/*/spec/**/*.proof.dfy", "!packages/*/spec/**/*.proof.dfy");
  writeLegacyConfig();
  const attached = await generationPlan(selected);

  for (const area of ["spec/kit", "apps/app/spec", "packages/ui/spec"]) {
    const file = `${area}/old.proof.dfy/model.md`;
    const directory = path.join(root, area);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "# Hidden model\n");
    const before = await generationPlan(selected);
    changed(attached, before, file);
    fs.appendFileSync(path.join(root, file), "\nA second version of this model.\n");
    const after = await generationPlan(selected);
    changed(before, after, file);
    assert.deepEqual(after.cssEnv, customEnv);
    if (area === "spec/kit") {
      assert.deepEqual(await generationPlan([`--root-turbo-json=${legacy}`]), after);
      assert.deepEqual(await generationPlan([], { TURBO_ROOT_TURBO_JSON: legacy }), after);
      assert.deepEqual(await generationPlan([...selected, "--cwd=packages/kit"]), after);
    }
    fs.rmSync(path.join(directory, "old.proof.dfy"), { recursive: true });
    if (area !== "spec/kit") fs.rmdirSync(directory);
  }

  const manifest = JSON.parse(read("package.json", root));
  for (const scripts of [{ ...manifest.scripts, pregen: "node -e 0" }, { ...manifest.scripts, gen: "node custom-generator.mjs" }]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...manifest, scripts }));
    const attached = await generationPlan(selected);
    fs.mkdirSync(standalone);
    changed(attached, await generationPlan(selected), "a legacy generation task with a project-defined command or hook");
    fs.rmdirSync(standalone);
  }

}
