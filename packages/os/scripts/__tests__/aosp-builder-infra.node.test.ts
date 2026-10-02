import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const kit = path.join(packageRoot, "android/builder");
const lockPath = path.join(packageRoot, "android/aosp.lock.json");
const scripts = [
  "gce/lib.sh",
  "gce/builder.sh",
  "gce/cuttlefish-host.sh",
  "bootstrap/sync-aosp.sh",
  "bootstrap/cuttlefish-host-startup.sh",
].map((p) => path.join(kit, p));

const which = (bin: string): string | null => {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const shellcheck = which("shellcheck");
const python3 = which("python3");
const hasPyYaml =
  python3 !== null &&
  spawnSync(python3, ["-c", "import yaml"], { stdio: "ignore" }).status === 0;
const secretPattern =
  /BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|ya29\.|ghp_[A-Za-z0-9]{20,}|xox[bp]-|password\s*[:=]|token\s*[:=]|secret\s*[:=]/i;

// Fake gcloud/repo/git first on PATH: any invocation leaves a marker file.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aosp-builder-test-"));
  const bin = path.join(dir, "bin");
  const marker = path.join(dir, "invoked");
  fs.mkdirSync(bin);
  for (const tool of ["gcloud", "repo", "hcloud", "terraform"]) {
    fs.writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${marker}"\nexit 97\n`,
      { mode: 0o755 },
    );
  }
  return { dir, marker, PATH: `${bin}:${process.env.PATH}` };
}

function runScript(
  script: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const box = sandbox();
  const r = spawnSync("bash", [path.join(kit, script), ...args], {
    encoding: "utf8",
    env: {
      PATH: box.PATH,
      HOME: box.dir,
      ...env,
    },
  });
  const invoked = fs.existsSync(box.marker)
    ? fs.readFileSync(box.marker, "utf8")
    : null;
  fs.rmSync(box.dir, { recursive: true, force: true });
  return { ...r, invoked };
}

// Shell scripts embedded in cloud-init write_files, extracted with PyYAML.
function embeddedScripts(): { path: string; content: string }[] {
  const out = execFileSync(
    python3,
    [
      "-c",
      `import json,sys,yaml
d=yaml.safe_load(open(sys.argv[1]))
print(json.dumps([f for f in d.get("write_files",[]) if f["content"].startswith("#!")]))`,
      path.join(kit, "bootstrap/cloud-init.yaml"),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

test("every builder shell script passes bash -n", () => {
  for (const s of scripts) execFileSync("bash", ["-n", s]);
});

test("every builder shell script is shellcheck clean", (t) => {
  if (!shellcheck) return t.skip("shellcheck not installed");
  const r = spawnSync(
    shellcheck,
    ["-x", "--severity=style", "--format=gcc", ...scripts],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("cloud-init is a valid #cloud-config document", (t) => {
  const text = fs.readFileSync(
    path.join(kit, "bootstrap/cloud-init.yaml"),
    "utf8",
  );
  assert.ok(text.startsWith("#cloud-config\n"));
  assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY|ssh-(rsa|ed25519) AAAA/);
  if (!hasPyYaml)
    return t.skip("python3 with PyYAML not available; parse check skipped");
  const doc = JSON.parse(
    execFileSync(
      python3,
      [
        "-c",
        "import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
        path.join(kit, "bootstrap/cloud-init.yaml"),
      ],
      { encoding: "utf8" },
    ),
  );
  assert.ok(doc.packages.includes("git-lfs"));
  assert.ok(doc.packages.includes("libc6-dev-i386"));
  assert.ok(doc.users.some((u) => u.name === "builder"));
  assert.ok(doc.swap.size);
  const files = doc.write_files.map((f) => f.path);
  assert.ok(files.includes("/etc/security/limits.d/90-aosp-builder.conf"));
  const repo = doc.write_files.find(
    (f) => f.path === "/usr/local/sbin/aosp-builder-install-repo",
  );
  assert.match(repo.content, /8BB9AD793E8E6153AF0F9A4416530D5E920F5C65/);
  assert.match(repo.content, /VALIDSIG/);
});

test("cloud-init embedded scripts pass bash -n and shellcheck", (t) => {
  if (!hasPyYaml)
    return t.skip(
      "python3 with PyYAML not available; embedded scripts skipped",
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aosp-cloud-init-"));
  try {
    const files = embeddedScripts();
    assert.ok(files.length >= 3);
    const paths = files.map((f) => {
      const p = path.join(dir, `${path.basename(f.path)}.sh`);
      fs.writeFileSync(p, f.content);
      execFileSync("bash", ["-n", p]);
      return p;
    });
    if (!shellcheck) return t.skip("shellcheck not installed");
    const r = spawnSync(shellcheck, ["--severity=style", ...paths], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("builder.sh dry run prints a SPOT c3d create and never calls gcloud", () => {
  const r = runScript("gce/builder.sh", ["create"], {
    PROJECT: "test-project",
    ZONE: "us-central1-b",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invoked, null, "gcloud must not run in dry-run mode");
  assert.match(r.stdout, /DRY RUN/);
  const create = r.stdout
    .split("\n")
    .find((l) => l.includes("compute instances create"));
  assert.ok(create, r.stdout);
  for (const flag of [
    "--project=test-project",
    "--zone=us-central1-b",
    "--machine-type=c3d-highcpu-90",
    "--provisioning-model=SPOT",
    "--instance-termination-action=STOP",
    "--image-family=ubuntu-2404-lts-amd64",
    "--no-address",
    "--shielded-secure-boot",
    "--shielded-vtpm",
    "--labels=",
    "device-name=aosp",
    "auto-delete=no",
    "--metadata-from-file=user-data=",
  ])
    assert.ok(create.includes(flag), `missing ${flag}`);
  const disk = r.stdout
    .split("\n")
    .find((l) => l.includes("compute disks create"));
  for (const flag of [
    "--type=hyperdisk-balanced",
    "--size=1500GB",
    "--provisioned-iops=",
    "--provisioned-throughput=",
  ])
    assert.ok(disk.includes(flag), `missing ${flag}`);
  assert.doesNotMatch(r.stdout, secretPattern);
});

test("builder.sh covers lifecycle subcommands in dry run", () => {
  const cases = [
    [["network"], /routers nats create/],
    [["start"], /compute instances start aosp-builder/],
    [["stop"], /compute instances stop aosp-builder/],
    [
      ["snapshot", "snap-1"],
      /compute snapshots create snap-1 --source-disk=aosp-builder-data/,
    ],
    [
      ["restore", "snap-1"],
      /--source-snapshot=snap-1[\s\S]*--provisioning-model=SPOT/,
    ],
    [["ssh"], /--tunnel-through-iap/],
    [
      ["delete"],
      /instances delete aosp-builder[\s\S]*data disk aosp-builder-data is kept/,
    ],
  ];
  for (const [args, pattern] of cases) {
    const r = runScript("gce/builder.sh", args);
    assert.equal(r.status, 0, `${args}: ${r.stderr}`);
    assert.equal(r.invoked, null);
    assert.match(r.stdout, pattern, args.join(" "));
    assert.doesNotMatch(r.stdout, secretPattern);
  }
});

test("builder.sh --apply fails closed without PROJECT", () => {
  const r = runScript("gce/builder.sh", ["--apply", "create"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PROJECT must be set/);
  assert.equal(r.invoked, null);
});

test("builder.sh refuses a data disk below the preflight size", () => {
  const r = runScript("gce/builder.sh", ["create"], {
    DATA_DISK_SIZE_GB: "1000",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /1500 GB/);
});

test("cuttlefish-host.sh dry run prints nested virtualization and never calls gcloud", () => {
  const r = runScript("gce/cuttlefish-host.sh", ["create"], {
    PROJECT: "test-project",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invoked, null);
  const create = r.stdout
    .split("\n")
    .find((l) => l.includes("compute instances create"));
  for (const flag of [
    "--machine-type=n2-standard-16",
    "--enable-nested-virtualization",
    "--provisioning-model=SPOT",
    "--instance-termination-action=STOP",
    "--metadata-from-file=startup-script=",
    "--no-address",
  ])
    assert.ok(create.includes(flag), `missing ${flag}`);
  assert.doesNotMatch(r.stdout, secretPattern);
});

test("cuttlefish-host.sh rejects AMD and Arm machine types", () => {
  for (const MACHINE_TYPE of [
    "c3d-highcpu-90",
    "c4a-standard-16",
    "n2d-standard-16",
  ]) {
    const r = runScript("gce/cuttlefish-host.sh", ["create"], { MACHINE_TYPE });
    assert.notEqual(r.status, 0, MACHINE_TYPE);
    assert.match(r.stderr, /nested virtualization/);
  }
});

test("cuttlefish-host.sh --apply fails closed without PROJECT", () => {
  const r = runScript("gce/cuttlefish-host.sh", ["--apply", "create"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PROJECT must be set/);
  assert.equal(r.invoked, null);
});

test("sync-aosp.sh dry run prints the locked cuttlefish tag and commit", () => {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const m = lock.profiles.cuttlefish.manifest;
  const r = runScript("bootstrap/sync-aosp.sh", [
    "--lock",
    lockPath,
    "--profile",
    "cuttlefish",
    "--jobs",
    "8",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invoked, null, "repo must not run in dry-run mode");
  assert.ok(r.stdout.includes(m.tag));
  assert.ok(r.stdout.includes(m.commit));
  assert.ok(r.stdout.includes(m.tagObject));
  assert.ok(
    r.stdout.includes(
      `repo init -u ${m.url} -b refs/tags/${m.tag} --partial-clone --clone-filter=blob:limit=10M`,
    ),
  );
  assert.ok(r.stdout.includes("repo sync -c -j8 --no-tags --optimized-fetch"));
  assert.ok(
    r.stdout.indexOf(`.repo/manifests HEAD == ${m.commit}`) <
      r.stdout.indexOf("repo sync"),
    "manifest commit check must precede repo sync",
  );
  for (const p of lock.profiles.cuttlefish.projects)
    assert.ok(r.stdout.includes(`${p.path} HEAD == ${p.commit}`));
  assert.doesNotMatch(r.stdout, secretPattern);
});

test("sync-aosp.sh supports mirror mode and rejects unknown profiles", () => {
  const mirror = runScript("bootstrap/sync-aosp.sh", [
    "--lock",
    lockPath,
    "--profile",
    "cuttlefish",
    "--mirror",
  ]);
  assert.equal(mirror.status, 0, mirror.stderr);
  assert.match(mirror.stdout, /repo init .* --mirror/);
  assert.doesNotMatch(mirror.stdout, /--partial-clone/);

  const missing = runScript("bootstrap/sync-aosp.sh", [
    "--lock",
    lockPath,
    "--profile",
    "no-such-profile",
  ]);
  assert.notEqual(missing.status, 0);
});

test("sync-aosp.sh fails closed on a malformed lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aosp-lock-"));
  try {
    const bad = path.join(dir, "lock.json");
    fs.writeFileSync(
      bad,
      JSON.stringify({
        profiles: {
          x: {
            manifest: {
              url: "http://insecure.example/manifest",
              tag: "t",
              tagObject: "0".repeat(40),
              commit: "1".repeat(40),
            },
          },
        },
      }),
    );
    const r = runScript("bootstrap/sync-aosp.sh", [
      "--lock",
      bad,
      "--profile",
      "x",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /https/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sync-aosp.sh reads packages/os/android/aosp.lock.json by default", () => {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const r = runScript("bootstrap/sync-aosp.sh", [
    "--profile",
    "cuttlefish",
    "--jobs",
    "2",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invoked, null);
  assert.ok(r.stdout.includes(lock.profiles.cuttlefish.manifest.commit));
  const missing = runScript("bootstrap/sync-aosp.sh", [
    "--lock",
    path.join(os.tmpdir(), "no-such-aosp.lock.json"),
    "--profile",
    "cuttlefish",
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /lock file not found/);
});

test("sync-aosp.sh checks commit-only projects without shifting fields", () => {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  for (const [name, profile] of Object.entries(lock.profiles) as [
    string,
    { projects?: { path: string; name: string; commit: string }[] },
  ][]) {
    for (const mode of [[], ["--mirror"]]) {
      const r = runScript("bootstrap/sync-aosp.sh", [
        "--profile",
        name,
        "--jobs",
        "2",
        ...mode,
      ]);
      assert.equal(r.status, 0, `${name} ${mode}: ${r.stderr}`);
      for (const project of profile.projects ?? [])
        assert.ok(
          r.stdout.includes(project.commit),
          `${name} ${mode} ${project.path}`,
        );
    }
  }
});

test("EXTRA_LABELS are appended and validated", () => {
  const ok = runScript("gce/builder.sh", ["create"], {
    EXTRA_LABELS: "product=acme,team=os",
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(
    ok.stdout,
    /--labels=purpose=aosp-builder,[^ ]*,product=acme,team=os/,
  );
  const bad = runScript("gce/cuttlefish-host.sh", ["create"], {
    EXTRA_LABELS: "Product=Acme Inc",
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /EXTRA_LABELS/);
});

test("builder kit carries no downstream product identity", () => {
  const files = fs
    .readdirSync(kit, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  for (const file of files)
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /senior|elizaresearch|vendor\/eliza\//i,
      file,
    );
});
