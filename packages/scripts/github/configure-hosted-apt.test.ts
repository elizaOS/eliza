import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const MIRRORS = "mirror+file:/etc/apt/eliza-ubuntu-mirrors.txt";

function source(uri: string, suites: string) {
  return `Types: deb\nURIs: ${uri}\nSuites: ${suites}\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n`;
}

/** Runs the script against a scratch /etc with a sudo that just runs the command. */
function configure(
  sources: string,
  osRelease = 'ID=ubuntu\nVERSION_ID="24.04"\n',
) {
  const root = mkdtempSync(join(tmpdir(), "hosted-apt-test-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "sudo"),
      '#!/usr/bin/env bash\nif [ "$1" = -n ]; then shift; fi\nexec "$@"\n',
      { mode: 0o755 },
    );
    mkdirSync(join(root, "etc/apt/sources.list.d"), { recursive: true });
    mkdirSync(join(root, "etc/apt/apt.conf.d"), { recursive: true });
    mkdirSync(join(root, "etc/cloud/templates"), { recursive: true });
    writeFileSync(join(root, "etc/os-release"), osRelease);
    const sourcesFile = join(root, "etc/apt/sources.list.d/ubuntu.sources");
    const template = join(
      root,
      "etc/cloud/templates/sources.list.ubuntu.deb822.tmpl",
    );
    writeFileSync(sourcesFile, sources);
    writeFileSync(template, sources);
    const run = () =>
      spawnSync(
        "bash",
        [new URL("./configure-hosted-apt.sh", import.meta.url).pathname],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            ELIZA_APT_TEST_ROOT: root,
          },
        },
      );
    const first = run();
    const once = readFileSync(sourcesFile, "utf8");
    const second = run();
    const read = (path: string) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    };
    return {
      first,
      second,
      once,
      sources: readFileSync(sourcesFile, "utf8"),
      template: readFileSync(template, "utf8"),
      mirrors: read("etc/apt/eliza-ubuntu-mirrors.txt"),
      ipv4: read("etc/apt/apt.conf.d/99-eliza-ci-force-ipv4"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("every known Ubuntu archive URI fails over across the ordered mirror list", () => {
  const original = [
    source("mirror+file:/etc/apt/apt-mirrors.txt", "noble noble-updates"),
    source("http://azure.archive.ubuntu.com/ubuntu/", "noble-backports"),
    source("https://archive.ubuntu.com/ubuntu/", "noble-security"),
    // Written by the previous single-mirror version of this script.
    source("https://mirrors.kernel.org/ubuntu/", "noble-proposed"),
  ].join("\n");
  const result = configure(original);
  assert.equal(result.first.status, 0, result.first.stderr);
  assert.equal(result.sources.match(/^URIs: /gm)?.length, 4);
  assert.equal(result.sources.split(`URIs: ${MIRRORS}`).length - 1, 4);
  assert.equal(result.template, result.sources);
  // Suites, components and the keyring are untouched.
  assert.equal(
    result.sources.replaceAll(/^URIs: .*$/gm, ""),
    original.replaceAll(/^URIs: .*$/gm, ""),
  );
  assert.deepEqual(result.mirrors?.trim().split("\n"), [
    "http://azure.archive.ubuntu.com/ubuntu/",
    "https://mirrors.kernel.org/ubuntu/",
    "http://archive.ubuntu.com/ubuntu/",
  ]);
  assert.equal(result.ipv4, 'Acquire::ForceIPv4 "true";\n');
});

test("re-running keeps the same sources, and unrelated feeds are left alone", () => {
  const unrelated = source("https://packages.example.test/apt/", "stable");
  const result = configure(
    `${source("mirror+file:/etc/apt/apt-mirrors.txt", "noble")}\n${unrelated}`,
  );
  assert.equal(result.second.status, 0, result.second.stderr);
  assert.equal(result.sources, result.once);
  assert.ok(result.sources.includes(unrelated));
});

test("other distributions and releases are not changed", () => {
  const original = source("http://archive.ubuntu.com/ubuntu/", "jammy");
  const result = configure(original, 'ID=ubuntu\nVERSION_ID="22.04"\n');
  assert.equal(result.first.status, 0, result.first.stderr);
  assert.equal(result.sources, original);
  assert.equal(result.mirrors, null);
});
