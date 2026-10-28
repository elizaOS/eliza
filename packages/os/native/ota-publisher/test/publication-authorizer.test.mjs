import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPublicationAuthorizer,
  verifyPublicationGraph,
} from "../publication-authorizer.mjs";
import {
  initializePublicationJournal,
  publishMetadataTransaction,
} from "../publication-transaction.mjs";
import {
  advancePublisherPolicy,
  initializePublisherPolicy,
  readPublisherPolicy,
} from "../publisher-policy.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const ROOT = Buffer.from('{"signed":{"_type":"root"},"signatures":[]}');
const NOW = 1790899200000;
const floors = () => ({
  root: 1,
  timestamp: 1,
  snapshot: 1,
  targets: 1,
  stable: 1,
  beta: 1,
});
const descriptorBytes = (id) => Buffer.from(JSON.stringify({ releaseId: id }));
const descriptorName = (channel, distribution, bytes) =>
  `targets/${channel}/${hash(bytes)}.${distribution}.json`;

function plan(v = 2) {
  const stable = descriptorBytes("stable-1"),
    beta = descriptorBytes("beta-1");
  return {
    id: `release-${v}`,
    timestamp: Buffer.from(
      JSON.stringify({ signed: { _type: "timestamp", version: v } }),
    ),
    dependencies: [
      { name: `${v}.snapshot.json`, bytes: Buffer.from("snapshot") },
      {
        name: descriptorName("stable", "launcher", stable),
        bytes: stable,
      },
      { name: descriptorName("beta", "launcher", beta), bytes: beta },
    ],
  };
}
/** Fake ports recording calls. The graph fake echoes the plan the way the Go
 * verifier reports it; options inject one failure at a time. */
function harness(options = {}) {
  const calls = [];
  let graphs = 0;
  const versions = { ...floors(), timestamp: 2, snapshot: 2 };
  const ports = {
    readPolicy: async () => {
      calls.push("policy");
      return {
        trustedUpperMs: NOW,
        minimumVersions: { ...floors(), ...options.floors },
      };
    },
    verifyGraph: async ({ root, bundle, policy }) => {
      graphs++;
      calls.push("graph");
      assert.deepEqual(root, ROOT);
      assert.equal(policy.trustedUpperMs, NOW);
      const descriptors = {};
      for (const { name, bytes } of bundle.dependencies) {
        const m =
          /^targets\/(stable|beta)\/[a-f0-9]{64}\.(launcher|standalone)\.json$/.exec(
            name,
          );
        if (m) descriptors[`${m[1]}/${m[2]}.json`] = JSON.parse(bytes);
      }
      const report = {
        graphVerified: true,
        timestampSha256: hash(bundle.timestamp),
        versions: { ...versions },
        descriptors,
      };
      options.graph?.(report, graphs);
      return report;
    },
    approveSource: async (subject) => {
      calls.push(`approve:${subject.path}`);
      assert.equal(
        hash(Buffer.from(JSON.stringify(subject.descriptor))),
        subject.descriptorSha256,
      );
      return options.approve ? options.approve(subject) : true;
    },
    preflight: async (subject) => {
      calls.push(`preflight:${subject.path}`);
      const [channel, file] = subject.path.split("/");
      const report = {
        descriptorSha256: subject.descriptorSha256,
        channel,
        distribution: file.replace(/\.json$/, ""),
      };
      return options.preflight ? options.preflight(report) : report;
    },
    advancePolicy: async (v) => {
      calls.push("advance");
      ports.advanced = v;
    },
  };
  return { ports, calls };
}

test("authorizes only a plan bound to a twice-verified graph with fresh approvals", async () => {
  const { ports, calls } = harness();
  const authorize = createPublicationAuthorizer(ports, { root: ROOT });
  const result = await authorize(plan());
  assert.deepEqual(result.descriptors, [
    "beta/launcher.json",
    "stable/launcher.json",
  ]);
  assert.equal(result.timestampSha256, hash(plan().timestamp));
  assert.deepEqual(calls, [
    "policy",
    "graph",
    "approve:beta/launcher.json",
    "preflight:beta/launcher.json",
    "approve:stable/launcher.json",
    "preflight:stable/launcher.json",
    "policy",
    "graph",
    "advance",
  ]);
  assert.equal(ports.advanced.snapshot, 2);
  // A second authorization repeats every check; nothing is cached.
  calls.length = 0;
  await authorize(plan());
  assert.equal(calls.filter((c) => c.startsWith("approve:")).length, 2);
  assert.equal(calls.filter((c) => c === "graph").length, 2);
});

test("requires every host port and the provisioned root", () => {
  for (const name of [
    "readPolicy",
    "verifyGraph",
    "approveSource",
    "preflight",
    "advancePolicy",
  ]) {
    const { ports } = harness();
    delete ports[name];
    assert.throws(
      () => createPublicationAuthorizer(ports, { root: ROOT }),
      new RegExp(`missing ${name}`),
    );
  }
  assert.throws(
    () => createPublicationAuthorizer(harness().ports, {}),
    /provisioned root/,
  );
});

test("rejects plans and graphs that do not bind the same exact descriptors", async () => {
  const cases = {
    "descriptor bytes renamed": [
      {},
      (p) => {
        p.dependencies[1].bytes = descriptorBytes("other");
      },
      /descriptor bytes do not match/,
    ],
    "no descriptor": [
      {},
      (p) => {
        p.dependencies = [p.dependencies[0]];
      },
      /no descriptor/,
    ],
    "graph has an extra descriptor": [
      {
        graph: (r) => {
          r.descriptors["stable/standalone.json"] = { releaseId: "x" };
        },
      },
      () => {},
      /differ from the signed graph/,
    ],
    "graph descriptor content differs": [
      {
        graph: (r) => {
          r.descriptors["stable/launcher.json"] = { releaseId: "x" };
        },
      },
      () => {},
      /signed graph descriptor differs/,
    ],
    "graph binds another timestamp": [
      { graph: (r) => (r.timestampSha256 = "0".repeat(64)) },
      () => {},
      /does not bind this plan/,
    ],
    "graph not verified": [
      { graph: (r) => (r.graphVerified = "true") },
      () => {},
      /does not bind this plan/,
    ],
    "graph below a raised durable floor": [
      { floors: { stable: 2 } },
      () => {},
      /stable version below durable floor/,
    ],
    "graph reports an invalid version": [
      { graph: (r) => (r.versions.stable = 0) },
      () => {},
      /does not bind this plan/,
    ],
    "approval is not exactly true": [
      { approve: () => "yes" },
      () => {},
      /source not approved/,
    ],
    "preflight for another descriptor": [
      { preflight: (r) => ({ ...r, descriptorSha256: "0".repeat(64) }) },
      () => {},
      /preflight evidence does not match/,
    ],
    "preflight for another channel": [
      { preflight: (r) => ({ ...r, channel: "stable" }) },
      () => {},
      /preflight evidence does not match/,
    ],
    "graph changed before the final check": [
      {
        graph: (r, n) => {
          if (n === 2) r.versions.snapshot = 3;
        },
      },
      () => {},
      /graph changed during release verification/,
    ],
  };
  for (const [name, [options, change, error]] of Object.entries(cases)) {
    const { ports, calls } = harness(options);
    const p = plan();
    change(p);
    await assert.rejects(
      createPublicationAuthorizer(ports, { root: ROOT })(p),
      error,
      name,
    );
    assert.ok(!calls.includes("advance"), `${name}: floors advanced`);
  }
});

test("final comparison ignores unauthenticated report fields", async () => {
  // A verifier may echo policy-derived values; only the authenticated
  // timestamp, versions and descriptors must stay identical.
  const { ports, calls } = harness({
    graph: (r, n) => (r.evaluatedUpperMs = NOW + n),
  });
  await createPublicationAuthorizer(ports, { root: ROOT })(plan());
  assert.equal(calls.at(-1), "advance");
});

test("drives publishMetadataTransaction: authorizes before writes and before CAS", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-authorize-")),
    journal = path.join(dir, "journal");
  try {
    initializePublicationJournal(journal);
    const { ports, calls } = harness();
    const objects = new Map([
      [
        "timestamp.json",
        Buffer.from(
          JSON.stringify({ signed: { _type: "timestamp", version: 1 } }),
        ),
      ],
    ]);
    const writes = [];
    const result = await publishMetadataTransaction(journal, plan(), {
      authorizeBundle: createPublicationAuthorizer(ports, { root: ROOT }),
      read: async (n) => (objects.has(n) ? Buffer.from(objects.get(n)) : null),
      putImmutable: async (n, b) => {
        writes.push(`put:${calls.filter((c) => c === "advance").length}`);
        objects.set(n, Buffer.from(b));
      },
      compareAndSwapTimestamp: async (expected, b) => {
        writes.push(`cas:${calls.filter((c) => c === "advance").length}`);
        if (hash(objects.get("timestamp.json")) !== expected) return false;
        objects.set("timestamp.json", Buffer.from(b));
        return true;
      },
    });
    assert.equal(result.status, "published");
    // Floors advanced once before the first write and again before the CAS.
    assert.deepEqual(writes, ["put:1", "put:1", "put:1", "cas:2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in verifier executable: checks its private inputs and echoes a
 * report, hangs, or prints garbage, as MODE selects. */
function fakeVerifier(dir, mode) {
  const file = path.join(dir, `verifier-${mode}.mjs`);
  fs.writeFileSync(
    file,
    `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2), at = (f) => args[args.indexOf(f) + 1];
for (const f of ["-root", "-bundle", "-policy"]) {
  const s = fs.statSync(at(f));
  if ((s.mode & 0o777) !== 0o400 || (fs.statSync(path.dirname(at(f))).mode & 0o777) !== 0o700) process.exit(3);
}
const bundle = JSON.parse(fs.readFileSync(at("-bundle"), "utf8"));
const policy = JSON.parse(fs.readFileSync(at("-policy"), "utf8"));
const timestamp = Buffer.from(bundle.files["timestamp.json"], "base64");
const mode = ${JSON.stringify(mode)};
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "garbage") process.stdout.write("not json");
else process.stdout.write(JSON.stringify({ graphVerified: true, upper: policy.trustedUpperMs,
  timestampSha256: mode === "other" ? "0".repeat(64) : createHash("sha256").update(timestamp).digest("hex"),
  versions: {}, descriptors: {}, files: Object.keys(bundle.files).sort() }));
`,
    { mode: 0o755 },
  );
  return file;
}

test("process verifier uses private inputs, a host deadline and exact timestamp binding", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-graph-cli-"));
  const before = new Set(fs.readdirSync(os.tmpdir()));
  try {
    const policy = { trustedUpperMs: NOW, minimumVersions: floors() };
    const base = {
      root: ROOT,
      bundle: plan(),
      policy,
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    };
    const report = await verifyPublicationGraph({
      ...base,
      executable: fakeVerifier(dir, "ok"),
    });
    assert.equal(report.upper, NOW);
    assert.deepEqual(
      report.files,
      ["timestamp.json", ...plan().dependencies.map((d) => d.name)].sort(),
    );
    await assert.rejects(
      verifyPublicationGraph({
        ...base,
        executable: fakeVerifier(dir, "other"),
      }),
      /does not bind this timestamp/,
    );
    await assert.rejects(
      verifyPublicationGraph({
        ...base,
        executable: fakeVerifier(dir, "garbage"),
      }),
      /not JSON/,
    );
    const started = Date.now();
    await assert.rejects(
      verifyPublicationGraph({
        ...base,
        executable: fakeVerifier(dir, "hang"),
        timeoutMs: 300,
      }),
    );
    assert.ok(
      Date.now() - started < 20_000,
      "host deadline stops a hung verifier",
    );
    const controller = new AbortController();
    const pending = verifyPublicationGraph({
      ...base,
      executable: fakeVerifier(dir, "hang"),
      signal: controller.signal,
    });
    controller.abort(new Error("operator cancelled"));
    await assert.rejects(pending);
    for (const missing of [
      { timeoutMs: undefined },
      { timeoutMs: 0 },
      { timeoutMs: 2 ** 31 },
      { signal: undefined },
      { executable: "verify-publication" },
      { policy: { trustedUpperMs: NOW, minimumVersions: { root: 1 } } },
      { root: Buffer.alloc(0) },
    ])
      await assert.rejects(
        verifyPublicationGraph({
          ...base,
          executable: fakeVerifier(dir, "ok"),
          ...missing,
        }),
        /OTA publication authorizer/,
      );
    const leaked = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("ota-publication-graph-") && !before.has(n));
    assert.deepEqual(leaked, [], "private inputs removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The signed-graph integration test requires the trust module's exact Go
// toolchain. The OTA publisher CI job installs it before running this suite.
const trust = fileURLToPath(new URL("../../ota-trust/", import.meta.url));

test("publishes a real signed fixture graph through the Go verifier", async () => {
  const want = /^go (\d+\.\d+\.\d+)$/m.exec(
    fs.readFileSync(path.join(trust, "go.mod"), "utf8"),
  )?.[1];
  assert.ok(want, "The trust module must pin its Go toolchain");
  const have = spawnSync("go", ["env", "GOVERSION"], {
    encoding: "utf8",
    env: { ...process.env, GOTOOLCHAIN: "local" },
  });
  assert.equal(have.status, 0, `Go ${want} is required on PATH`);
  assert.equal(
    have.stdout.trim(),
    `go${want}`,
    "Use the trust module's pinned Go toolchain",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-authorize-go-"));
  try {
    const env = {
      ...process.env,
      GOTOOLCHAIN: "local",
      GOFLAGS: "-buildvcs=false",
    };
    execFileSync(
      "go",
      ["test", "-count=1", "-run", "^TestExportPublicationFixture$", "."],
      {
        cwd: trust,
        env: { ...env, OTA_PUBLICATION_FIXTURE: dir },
        stdio: "pipe",
      },
    );
    const executable = path.join(dir, "verify-publication");
    execFileSync(
      "go",
      ["build", "-o", executable, "./cmd/verify-publication"],
      {
        cwd: trust,
        env,
        stdio: "pipe",
      },
    );
    const fixture = JSON.parse(
      fs.readFileSync(path.join(dir, "publication-fixture.json"), "utf8"),
    );
    const root = Buffer.from(fixture.root, "base64");
    const files = Object.entries(fixture.files).map(([name, b64]) => ({
      name,
      bytes: Buffer.from(b64, "base64"),
    }));
    const publication = {
      id: "fixture-1",
      timestamp: files.find((f) => f.name === "timestamp.json").bytes,
      dependencies: files.filter((f) => f.name !== "timestamp.json"),
    };
    const policyFile = path.join(dir, "policy.sqlite"),
      journal = path.join(dir, "journal");
    initializePublisherPolicy(policyFile, floors());
    initializePublicationJournal(journal);
    const approvals = [];
    const authorize = createPublicationAuthorizer(
      {
        readPolicy: () =>
          readPublisherPolicy(policyFile, fixture.trustedUpperMs),
        verifyGraph: (input) =>
          verifyPublicationGraph({
            ...input,
            executable,
            signal: new AbortController().signal,
            timeoutMs: 60_000,
          }),
        approveSource: ({ path: p }) => {
          approvals.push(p);
          return true;
        },
        preflight: ({ path: p, descriptorSha256 }) => {
          const [channel, file] = p.split("/");
          return {
            descriptorSha256,
            channel,
            distribution: file.replace(/\.json$/, ""),
          };
        },
        advancePolicy: (versions) =>
          advancePublisherPolicy(policyFile, versions),
      },
      { root },
    );
    const objects = new Map();
    const result = await publishMetadataTransaction(journal, publication, {
      authorizeBundle: authorize,
      read: async (n) => (objects.has(n) ? Buffer.from(objects.get(n)) : null),
      putImmutable: async (n, b) => void objects.set(n, Buffer.from(b)),
      compareAndSwapTimestamp: async (expected, b) => {
        if (expected !== null || objects.has("timestamp.json")) return false;
        objects.set("timestamp.json", Buffer.from(b));
        return true;
      },
    });
    assert.equal(result.status, "published");
    assert.deepEqual(approvals, [
      "stable/launcher.json",
      "stable/launcher.json",
    ]);
    assert.deepEqual(
      readPublisherPolicy(policyFile, fixture.trustedUpperMs).minimumVersions,
      floors(),
    );
    // A tampered descriptor fails the real signed graph before any approval.
    const tampered = structuredClone(publication);
    tampered.id = "fixture-tampered";
    const index = tampered.dependencies.findIndex((d) =>
      d.name.startsWith("targets/"),
    );
    tampered.dependencies[index] = {
      name: tampered.dependencies[index].name,
      bytes: Buffer.from('{"releaseId":"attacker"}'),
    };
    approvals.length = 0;
    await assert.rejects(authorize(tampered));
    assert.deepEqual(approvals, []);
    // Expired metadata (qualified time past the timestamp expiry) is refused.
    const late = createPublicationAuthorizer(
      {
        readPolicy: () =>
          readPublisherPolicy(
            policyFile,
            fixture.trustedUpperMs + 2 * 3600_000,
          ),
        verifyGraph: (input) =>
          verifyPublicationGraph({
            ...input,
            executable,
            signal: new AbortController().signal,
            timeoutMs: 60_000,
          }),
        approveSource: () => true,
        preflight: () => ({}),
        advancePolicy: () =>
          assert.fail("floors advanced for expired metadata"),
      },
      { root },
    );
    await assert.rejects(late(publication));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
