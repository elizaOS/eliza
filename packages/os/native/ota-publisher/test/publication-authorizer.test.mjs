import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { createPublicationAuthorizer } from "../publication-authorizer.mjs";
import { fixture } from "./release-fixture.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
function scenario() {
  const descriptor = fixture().release,
    bytes = Buffer.from(JSON.stringify(descriptor)),
    timestamp = Buffer.from('{"signed":{"_type":"timestamp","version":1}}'),
    target = `${descriptor.channel}/${descriptor.distribution}.json`,
    sha = hash(bytes),
    calls = [];
  let directory;
  const options = {
    root: Buffer.from("{}"),
    hosts: ["github.com"],
    artifacts: {
      [target]: {
        expectedSigner: descriptor.candidate.signerSha256,
        candidate: "candidate",
        recovery: "recovery",
      },
    },
    readPolicy: async () => {
      calls.push("policy");
      return { trustedUpperMs: 1 };
    },
    approveSource: async (s) => {
      calls.push("approval");
      return { approved: true, descriptorSha256: s.descriptorSha256 };
    },
  };
  const ports = {
    verifyGraph: async (input) => {
      directory = input.directory;
      calls.push("graph");
      assert.equal(
        input.bundle.files[
          `targets/${descriptor.channel}/${sha}.${descriptor.distribution}.json`
        ],
        bytes.toString("base64"),
      );
      return {
        graphVerified: true,
        timestampSha256: hash(timestamp),
        descriptors: { [target]: descriptor },
        versions: { timestamp: 1 },
      };
    },
    preflight: async (o) => {
      calls.push("preflight");
      assert.deepEqual(fs.readFileSync(o.descriptorFile), bytes);
      return {
        preflightPassed: true,
        descriptorSha256: sha,
        channel: descriptor.channel,
        distribution: descriptor.distribution,
      };
    },
  };
  return {
    options,
    ports,
    calls,
    plan: {
      id: "test",
      timestamp,
      dependencies: [
        {
          name: `targets/${descriptor.channel}/${sha}.${descriptor.distribution}.json`,
          bytes,
        },
      ],
    },
    clean: () => assert.equal(fs.existsSync(directory), false),
  };
}
test("publication authorization reruns fresh policy, graph, approval and preflight with original bytes", async () => {
  const s = scenario(),
    authorize = createPublicationAuthorizer(s.options, s.ports);
  for (let i = 0; i < 2; i++) {
    assert.equal((await authorize(s.plan)).authorized, true);
    s.clean();
  }
  assert.deepEqual(s.calls, [
    "policy",
    "graph",
    "approval",
    "preflight",
    "policy",
    "graph",
    "policy",
    "graph",
    "approval",
    "preflight",
    "policy",
    "graph",
  ]);
});
test("graph failure prevents source approvals and preflight, with cleanup", async () => {
  const s = scenario(),
    verify = s.ports.verifyGraph;
  s.ports.verifyGraph = async (p) => {
    await verify(p);
    throw Error("bad signature");
  };
  await assert.rejects(
    createPublicationAuthorizer(s.options, s.ports)(s.plan),
    /bad signature/,
  );
  assert.deepEqual(s.calls, ["policy", "graph"]);
  s.clean();
});
test("authorization rejects stale graph subject, descriptor set and descriptor contents", async () => {
  for (const change of [
    (g) => (g.timestampSha256 = "0".repeat(64)),
    (g) => (g.descriptors = {}),
    (g) => (Object.values(g.descriptors)[0].releaseId = "wrong"),
  ]) {
    const s = scenario(),
      verify = s.ports.verifyGraph;
    s.ports.verifyGraph = async (p) => {
      const g = structuredClone(await verify(p));
      change(g);
      return g;
    };
    await assert.rejects(
      createPublicationAuthorizer(s.options, s.ports)(s.plan),
      /graph/,
    );
    s.clean();
  }
});
test("missing or stale source approval prevents preflight", async () => {
  for (const approval of [
    null,
    { approved: true, descriptorSha256: "0".repeat(64) },
    { approved: false },
  ]) {
    const s = scenario();
    s.options.approveSource = async () => approval;
    await assert.rejects(
      createPublicationAuthorizer(s.options, s.ports)(s.plan),
      /source approval/,
    );
    assert.equal(s.calls.includes("preflight"), false);
    s.clean();
  }
});
test("stale or mismatched release preflight fails authorization", async () => {
  for (const report of [
    { preflightPassed: false },
    { preflightPassed: true, descriptorSha256: "0".repeat(64) },
  ]) {
    const s = scenario();
    s.ports.preflight = async () => report;
    await assert.rejects(
      createPublicationAuthorizer(s.options, s.ports)(s.plan),
      /preflight subject/,
    );
    s.clean();
  }
});
test("duplicate descriptors and altered bytes fail before any authority calls", async () => {
  for (const change of [
    (p) => p.dependencies.push(p.dependencies[0]),
    (p) => (p.dependencies[0].bytes = Buffer.from("{}")),
  ]) {
    const s = scenario();
    change(s.plan);
    await assert.rejects(
      createPublicationAuthorizer(s.options, s.ports)(s.plan),
      /dependency|descriptor/,
    );
    assert.deepEqual(s.calls, []);
  }
});

test("transaction uses authorization twice and cannot commit when fresh pre-CAS approval fails", async () => {
  const os = await import("node:os"),
    path = await import("node:path");
  const { initializePublicationJournal } = await import(
    "../publication-transaction.mjs"
  );
  const { publishAuthorizedMetadata } = await import(
    "../publication-authorizer.mjs"
  );
  for (const rejectSecond of [false, true]) {
    const s = scenario(),
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-transaction-")),
      journal = path.join(dir, "journal.db"),
      objects = new Map();
    let approvals = 0,
      commits = 0;
    initializePublicationJournal(journal);
    s.options.approveSource = async (input) => ({
      approved: !(rejectSecond && ++approvals === 2),
      descriptorSha256: input.descriptorSha256,
    });
    const storage = {
      read: async (name) => objects.get(name) ?? null,
      putImmutable: async (name, bytes) => objects.set(name, bytes),
      compareAndSwapTimestamp: async (previous, bytes) => {
        assert.equal(previous, null);
        commits++;
        objects.set("timestamp.json", bytes);
        return true;
      },
      authorizeBundle: async () => {
        throw Error("storage cannot supply authority");
      },
    };
    try {
      const run = publishAuthorizedMetadata(
        journal,
        s.plan,
        s.options,
        storage,
        s.ports,
      );
      if (rejectSecond) {
        await assert.rejects(run, /source approval/);
        assert.equal(objects.has("timestamp.json"), false);
        assert.equal(commits, 0);
      } else {
        assert.equal((await run).status, "published");
        assert.equal(commits, 1);
        assert.equal(s.calls.filter((c) => c === "graph").length, 4);
      }
      s.clean();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("expiry or floor advancement during artifact preflight prevents authorization", async () => {
  const s = scenario(),
    verify = s.ports.verifyGraph;
  let count = 0;
  s.ports.verifyGraph = async (input) => {
    const g = await verify(input);
    if (++count === 2) throw Error("expired after preflight");
    return g;
  };
  await assert.rejects(
    createPublicationAuthorizer(s.options, s.ports)(s.plan),
    /expired after preflight/,
  );
  assert.equal(s.calls.includes("preflight"), true);
  s.clean();
});

test("durable publication persists verified floors before storage and rejects concurrent advancement", async () => {
  const os = await import("node:os"),
    path = await import("node:path");
  const { initializePublicationJournal } = await import(
    "../publication-transaction.mjs"
  );
  const { publishWithDurablePolicy } = await import(
    "../publication-authorizer.mjs"
  );
  const {
    initializePublisherPolicy,
    readPublisherPolicy,
    advancePublisherPolicy,
  } = await import("../publisher-policy.mjs");
  for (const conflict of [false, true]) {
    const s = scenario(),
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-auth-")),
      journal = path.join(dir, "journal.db"),
      policyFile = path.join(dir, "policy.db"),
      base = Object.fromEntries(
        ["root", "timestamp", "snapshot", "targets", "stable", "beta"].map(
          (r) => [r, 1],
        ),
      ),
      accepted = { ...base, stable: 2 },
      objects = new Map();
    let reads = 0;
    initializePublicationJournal(journal);
    initializePublisherPolicy(policyFile, base);
    const verify = s.ports.verifyGraph;
    s.ports.verifyGraph = async (input) => ({
      ...(await verify(input)),
      versions: accepted,
    });
    const preflight = s.ports.preflight;
    s.ports.preflight = async (o) => {
      const result = await preflight(o);
      if (conflict) advancePublisherPolicy(policyFile, { ...base, stable: 3 });
      return result;
    };
    const storage = {
      read: async (name) => {
        reads++;
        assert.equal(
          readPublisherPolicy(policyFile, 1).minimumVersions.stable,
          2,
        );
        return objects.get(name) ?? null;
      },
      putImmutable: async (name, bytes) => objects.set(name, bytes),
      compareAndSwapTimestamp: async (_previous, bytes) => {
        objects.set("timestamp.json", bytes);
        return true;
      },
    };
    try {
      const run = publishWithDurablePolicy(
        journal,
        s.plan,
        { ...s.options, policyFile, qualifiedUpperMs: async () => 100 },
        storage,
        s.ports,
      );
      if (conflict) {
        await assert.rejects(run, /rollback/);
        assert.equal(reads, 0);
        assert.equal(
          readPublisherPolicy(policyFile, 1).minimumVersions.stable,
          3,
        );
      } else {
        assert.equal((await run).status, "published");
        assert.deepEqual(
          readPublisherPolicy(policyFile, 1).minimumVersions,
          accepted,
        );
      }
      s.clean();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
