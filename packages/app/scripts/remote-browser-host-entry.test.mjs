import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("managed image source closure includes every required workspace dependency", () => {
  const docker = read("packages/cloud/services/agent-server/Dockerfile");
  const manifest = JSON.parse(
    /RUN printf '([^']+)/.exec(docker)[1].replace(/\\n$/, ""),
  );
  const packages = new Map(
    manifest.workspaces.map((path) => {
      const info = JSON.parse(read(`${path}/package.json`));
      return [info.name, { path, info }];
    }),
  );
  for (const { path, info } of packages.values()) {
    assert.ok(docker.includes(`COPY ${path}/package.json ${path}/`), path);
    assert.ok(docker.includes(`COPY ${path} ${path}`), path);
    for (const [name, version] of Object.entries(info.dependencies ?? {})) {
      if (version.startsWith("workspace:"))
        assert.ok(packages.has(name), `${info.name} needs ${name}`);
    }
  }
  assert.ok(packages.has("@elizaos/remote-control-host"));
  assert.ok(packages.has("@elizaos/plugin-browser"));
  assert.ok(packages.has("@elizaos/plugin-web-search"));
  assert.ok(!packages.has("@elizaos/app"));
  assert.ok(!packages.has("@elizaos/ui"));
});

test("standalone cloud image ships reviewed host code and invokes it after runtime initialization", () => {
  const docker = read("packages/app/deploy/Dockerfile.cloud-agent");
  const entry = read("packages/app/deploy/cloud-agent-shared.ts");
  assert.match(
    docker,
    /COPY eliza\/packages\/remote-control-host packages\/remote-control-host/,
  );
  assert.match(docker, /FROM oven\/bun:1\.3\.14 AS bun-runtime/);
  assert.match(
    docker,
    /CMD \["bun", "--conditions=eliza-source", "entrypoint.mjs"\]/,
  );
  assert.doesNotMatch(docker, /@elizaos\/core@alpha/);
  assert.ok(
    entry.indexOf("await remoteHost.restoreRemoteBrowserController(runtime)") >
      entry.indexOf("await runtime.initialize()"),
  );
  assert.ok(
    entry.indexOf("if (remoteBrowserPath)") >
      entry.indexOf("if (authHeader !== `Bearer"),
  );
  assert.match(entry, /remoteBrowser\.pair\(body, ownerId\)/);
});
