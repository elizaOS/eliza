/**
 * Publishes real immutable tarballs to a local Verdaccio process, kills the
 * registry after the first package to create a genuine transport interruption,
 * then restarts the same storage and proves integrity-matched resume plus final
 * channel promotion without any public npm contact.
 */

import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  buildAndPackReleaseCandidate,
  loadReleaseState,
} from "../lib/release-candidate.mjs";
import {
  inspectRegistryChannel,
  inspectReleaseRegistry,
  publishReleaseCandidate,
} from "../lib/release-registry.mjs";

const roots: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      Bun.sleep(750),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function git(repoRoot: string, args: string[]) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to reserve a local port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function makeRepo(base: string) {
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(repoRoot);
  writeJson(path.join(repoRoot, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  const common = {
    version: "1.0.0",
    type: "module",
    main: "dist/index.js",
    files: ["dist"],
    publishConfig: { access: "public" },
  };
  writeJson(path.join(repoRoot, "packages/a/package.json"), {
    name: "@eliza-release-integration/a",
    ...common,
    dependencies: { "@eliza-release-integration/b": "1.0.0" },
  });
  writeJson(path.join(repoRoot, "packages/b/package.json"), {
    name: "@eliza-release-integration/b",
    ...common,
  });
  fs.writeFileSync(
    path.join(repoRoot, "build.mjs"),
    [
      'import fs from "node:fs";',
      'for (const name of ["a", "b"]) {',
      '  fs.mkdirSync("packages/" + name + "/dist", { recursive: true });',
      '  fs.writeFileSync("packages/" + name + "/dist/index.js", "export default " + JSON.stringify(name) + ";\\n");',
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "dist/\n");
  git(repoRoot, ["init", "-b", "develop"]);
  git(repoRoot, ["config", "user.name", "Verdaccio Test"]);
  git(repoRoot, ["config", "user.email", "verdaccio@example.test"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "candidate source"]);
  return { repoRoot, sourceSha: git(repoRoot, ["rev-parse", "HEAD"]) };
}

async function startVerdaccio(base: string, port: number) {
  const configPath = path.join(base, "verdaccio.yaml");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      [
        "storage: ./storage",
        "auth:",
        "  htpasswd:",
        "    file: ./htpasswd",
        "    max_users: 1000",
        "uplinks: {}",
        "packages:",
        "  '@*/*':",
        "    access: $all",
        "    publish: $authenticated",
        "    unpublish: $authenticated",
        "  '**':",
        "    access: $all",
        "    publish: $authenticated",
        "    unpublish: $authenticated",
        "log:",
        "  type: stdout",
        "  format: pretty",
        "  level: warn",
        "",
      ].join("\n"),
    );
  }
  const executable = path.resolve("node_modules/.bin/verdaccio");
  const child = spawn(
    executable,
    ["--config", configPath, "--listen", `127.0.0.1:${port}`],
    {
      cwd: base,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.push(child);
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  const registryUrl = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Verdaccio exited before readiness:\n${logs}`);
    try {
      const response = await fetch(new URL("-/ping", registryUrl));
      if (response.ok) return { child, registryUrl, logs: () => logs };
    } catch {
      // error-policy:J3 readiness polling distinguishes not-ready from test failure
    }
    await Bun.sleep(50);
  }
  throw new Error(`Verdaccio did not become ready:\n${logs}`);
}

async function createUser(registryUrl: string) {
  const username = "release-integration";
  const response = await fetch(
    new URL(`-/user/org.couchdb.user:${username}`, registryUrl),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: username,
        password: "release-password",
        email: "release@example.test",
        type: "user",
        roles: [],
      }),
    },
  );
  const source = await response.text();
  if (!response.ok)
    throw new Error(
      `Verdaccio user creation failed (${response.status}): ${source}`,
    );
  const metadata = JSON.parse(source);
  if (typeof metadata.token !== "string")
    throw new Error(`Verdaccio omitted auth token: ${source}`);
  return metadata.token;
}

function writeNpmConfig(base: string, registryUrl: string) {
  const parsed = new URL(registryUrl);
  const npmrc = path.join(base, "npmrc");
  fs.writeFileSync(
    npmrc,
    [
      `registry=${registryUrl}`,
      `@eliza-release-integration:registry=${registryUrl}`,
      `//${parsed.host}${parsed.pathname}:_authToken=\${NODE_AUTH_TOKEN}`,
      "fetch-retries=0",
      "fetch-timeout=1000",
      "",
    ].join("\n"),
  );
  return npmrc;
}

function writeInterruptingNpm(
  base: string,
  verdaccioPid: number,
  npmConfigPath: string,
) {
  const wrapper = path.join(base, "interrupting-npm.sh");
  const countPath = path.join(base, "publish-count");
  const realNpm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export NPM_CONFIG_USERCONFIG=${JSON.stringify(npmConfigPath)}`,
      'if [[ "$' + '{1:-}" == "publish" ]]; then',
      `  COUNT_FILE=${JSON.stringify(countPath)}`,
      '  count=0; [[ -f "$COUNT_FILE" ]] && count=$(cat "$COUNT_FILE")',
      '  count=$((count + 1)); printf "%s" "$count" > "$COUNT_FILE"',
      '  if [[ "$count" -eq 2 ]]; then',
      `    kill -TERM ${verdaccioPid}`,
      `    for _ in $(seq 1 100); do`,
      `      [[ ! -r /proc/${verdaccioPid}/stat ]] && break`,
      `      [[ $(awk '{print $3}' /proc/${verdaccioPid}/stat) == Z ]] && break`,
      "      sleep 0.05",
      "    done",
      "  fi",
      "fi",
      `exec ${JSON.stringify(realNpm)} "$@"`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function writeAuthenticatedNpm(base: string, npmConfigPath: string) {
  const wrapper = path.join(base, "authenticated-npm.sh");
  const realNpm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export NPM_CONFIG_USERCONFIG=${JSON.stringify(npmConfigPath)}`,
      `exec ${JSON.stringify(realNpm)} "$@"`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("real Verdaccio transport failure resumes only the integrity-matched partial publication", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-verdaccio-"));
  roots.push(base);
  const fixture = makeRepo(base);
  const candidateDirectory = path.join(base, "candidate");
  const candidate = buildAndPackReleaseCandidate({
    repoRoot: fixture.repoRoot,
    outputDirectory: candidateDirectory,
    packageNames: [
      "@eliza-release-integration/a",
      "@eliza-release-integration/b",
    ],
    version: "1.0.0",
    channel: "beta",
    sourceSha: fixture.sourceSha,
    expectedCommit: fixture.sourceSha,
    build: { command: process.execPath, args: ["build.mjs"] },
  });
  const port = await unusedPort();
  const firstServer = await startVerdaccio(base, port);
  const token = await createUser(firstServer.registryUrl);
  const npmConfigPath = writeNpmConfig(base, firstServer.registryUrl);
  const interruptingNpm = writeInterruptingNpm(
    base,
    firstServer.child.pid as number,
    npmConfigPath,
  );
  await expect(
    publishReleaseCandidate({
      repoRoot: fixture.repoRoot,
      candidateDirectory,
      registryUrl: firstServer.registryUrl,
      token,
      npmCommand: interruptingNpm,
    }),
  ).rejects.toThrow("npm publish failed");
  expect(loadReleaseState(candidateDirectory).state.phase).toBe(
    "registry-bound",
  );
  await waitForExit(firstServer.child);
  await expect(
    publishReleaseCandidate({
      repoRoot: fixture.repoRoot,
      candidateDirectory,
      registryUrl: new URL("alternate/", firstServer.registryUrl).toString(),
      token,
      npmCommand: interruptingNpm,
    }),
  ).rejects.toThrow("Candidate registry is");

  const resumedServer = await startVerdaccio(base, port);
  const partial = await inspectReleaseRegistry({
    registryUrl: resumedServer.registryUrl,
    plan: candidate.plan,
    token,
  });
  expect(partial.map(({ state }) => state).sort()).toEqual([
    "matched",
    "missing",
  ]);

  const resumed = await publishReleaseCandidate({
    repoRoot: fixture.repoRoot,
    candidateDirectory,
    registryUrl: resumedServer.registryUrl,
    token,
    npmCommand: writeAuthenticatedNpm(base, npmConfigPath),
  });
  expect(resumed.state).toBe("channel-promoted");
  expect(loadReleaseState(candidateDirectory).state.phase).toBe(
    "channel-promoted",
  );
  expect(
    await inspectReleaseRegistry({
      registryUrl: resumedServer.registryUrl,
      plan: candidate.plan,
      token,
    }),
  ).toEqual(
    candidate.plan.packages.map(({ name, version, tarball }) => ({
      name,
      version,
      state: "matched",
      integrity: tarball.integrity,
    })),
  );
  for (const packageRecord of candidate.plan.packages) {
    expect(
      await inspectRegistryChannel({
        registryUrl: resumedServer.registryUrl,
        packageRecord,
        channel: "beta",
        token,
      }),
    ).toBe("1.0.0");
  }
  expect(
    await publishReleaseCandidate({
      repoRoot: fixture.repoRoot,
      candidateDirectory,
      registryUrl: resumedServer.registryUrl,
      token,
      npmCommand: writeAuthenticatedNpm(base, npmConfigPath),
    }),
  ).toMatchObject({ state: "channel-promoted" });
  await expect(
    publishReleaseCandidate({
      repoRoot: fixture.repoRoot,
      candidateDirectory,
      registryUrl: new URL("alternate/", resumedServer.registryUrl).toString(),
      token,
      npmCommand: writeAuthenticatedNpm(base, npmConfigPath),
    }),
  ).rejects.toThrow("Candidate registry is");
}, 120_000);
