import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializePublicationJournal,
  publishMetadataTransaction,
} from "../publication-transaction.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex"),
  timestamp = (v) =>
    Buffer.from(
      JSON.stringify({
        signed: { _type: "timestamp", version: v },
        signatures: [],
      }),
    );
function plan(id = "release-2", v = 2) {
  return {
    id,
    timestamp: timestamp(v),
    dependencies: [
      {
        name: `${v}.snapshot.json`,
        bytes: Buffer.from("controlled signed dependency fixture"),
      },
    ],
  };
}
async function setup(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-publish-")),
    journal = path.join(dir, "journal");
  initializePublicationJournal(journal);
  const objects = new Map([["timestamp.json", timestamp(1)]]),
    calls = [];
  let authorizations = 0;
  const ports = {
    authorizeBundle: async () => {
      authorizations++;
    },
    read: async (n) => (objects.has(n) ? Buffer.from(objects.get(n)) : null),
    putImmutable: async (n, b) => {
      calls.push("dependency");
      if (!objects.has(n)) objects.set(n, Buffer.from(b));
    },
    compareAndSwapTimestamp: async (expected, b) => {
      calls.push("timestamp");
      const old = objects.get("timestamp.json");
      if ((old ? hash(old) : null) !== expected) return false;
      objects.set("timestamp.json", Buffer.from(b));
      return true;
    },
  };
  try {
    await run({
      journal,
      objects,
      ports,
      calls,
      authorizations: () => authorizations,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("publication writes and verifies immutable dependencies before timestamp and is idempotent", () =>
  setup(async (s) => {
    assert.equal(
      (await publishMetadataTransaction(s.journal, plan(), s.ports)).status,
      "published",
    );
    assert.deepEqual(s.calls, ["dependency", "timestamp"]);
    assert.equal(s.authorizations(), 2);
    await publishMetadataTransaction(s.journal, plan(), s.ports);
    assert.deepEqual(s.calls, ["dependency", "timestamp"]);
    await assert.rejects(
      publishMetadataTransaction(s.journal, plan("release-2", 3), s.ports),
      /reused/,
    );
  }));
test("publication resumes after every durable boundary without duplicate timestamp mutation", async () => {
  for (const boundary of [
    "intent-durable",
    "dependency-written",
    "dependencies-verified",
    "commit-intent-durable",
    "timestamp-cas-returned",
    "published-durable",
  ])
    await setup(async (s) => {
      await assert.rejects(
        publishMetadataTransaction(s.journal, plan(), s.ports, (p) => {
          if (p === boundary) throw Error("interrupted");
        }),
        /interrupted/,
      );
      assert.equal(
        (await publishMetadataTransaction(s.journal, plan(), s.ports)).status,
        "published",
      );
      assert.equal(s.calls.filter((c) => c === "timestamp").length, 1);
    });
});
test("lost CAS reply is reconciled from exact remote bytes", () =>
  setup(async (s) => {
    const original = s.ports.compareAndSwapTimestamp;
    s.ports.compareAndSwapTimestamp = async (...args) => {
      await original(...args);
      throw Error("reply lost");
    };
    await assert.rejects(
      publishMetadataTransaction(s.journal, plan(), s.ports),
      /reply lost/,
    );
    s.ports.compareAndSwapTimestamp = original;
    assert.equal(
      (await publishMetadataTransaction(s.journal, plan(), s.ports)).status,
      "published",
    );
    assert.equal(s.calls.filter((c) => c === "timestamp").length, 1);
  }));
test("immutable conflicts and revoked authorization leave timestamp untouched", async () => {
  await setup(async (s) => {
    s.objects.set("2.snapshot.json", Buffer.from("different"));
    await assert.rejects(
      publishMetadataTransaction(s.journal, plan(), s.ports),
      /immutable dependency conflict/,
    );
    assert.deepEqual(s.objects.get("timestamp.json"), timestamp(1));
  });
  await setup(async (s) => {
    let n = 0;
    s.ports.authorizeBundle = async () => {
      if (++n === 2) throw Error("rollout revoked");
    };
    await assert.rejects(
      publishMetadataTransaction(s.journal, plan(), s.ports),
      /revoked/,
    );
    assert.deepEqual(s.objects.get("timestamp.json"), timestamp(1));
  });
});
test("concurrent timestamp advance cannot be overwritten; old completed transactions stay superseded", () =>
  setup(async (s) => {
    const original = s.ports.compareAndSwapTimestamp;
    s.ports.compareAndSwapTimestamp = async (...args) => {
      s.objects.set("timestamp.json", timestamp(9));
      return original(...args);
    };
    await assert.rejects(
      publishMetadataTransaction(s.journal, plan(), s.ports),
      /not confirmed/,
    );
    await assert.rejects(
      publishMetadataTransaction(s.journal, plan(), s.ports),
      /another publisher/,
    );
    assert.deepEqual(s.objects.get("timestamp.json"), timestamp(9));
  }));
test("completed publication is never replayed over later publication", () =>
  setup(async (s) => {
    await publishMetadataTransaction(s.journal, plan(), s.ports);
    await publishMetadataTransaction(s.journal, plan("next", 3), s.ports);
    assert.equal(
      (await publishMetadataTransaction(s.journal, plan(), s.ports)).status,
      "superseded",
    );
    assert.deepEqual(s.objects.get("timestamp.json"), timestamp(3));
  }));
test("missing journals, backwards versions and unsafe paths stop publication", () =>
  setup(async (s) => {
    await assert.rejects(
      publishMetadataTransaction(`${s.journal}.missing`, plan(), s.ports),
    );
    await assert.rejects(
      publishMetadataTransaction(s.journal, plan("old", 1), s.ports),
    );
    const bad = plan();
    bad.dependencies[0].name = "../timestamp.json";
    await assert.rejects(
      publishMetadataTransaction(s.journal, bad, s.ports),
      /invalid/,
    );
    assert.deepEqual(s.calls, []);
  }));

test("actual publisher process termination preserves recoverable intent and avoids duplicate commit", {
  timeout: 30000,
}, async () => {
  const { spawnSync } = await import("node:child_process"),
    { pathToFileURL } = await import("node:url");
  const moduleURL = new URL("../publication-transaction.mjs", import.meta.url)
    .href;
  // Durable single-worker fake object store. It models acknowledged writes and
  // lost replies, not cloud-store CAS concurrency or production signing trust.
  const source = `import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {publishMetadataTransaction} from ${JSON.stringify(moduleURL)};
 const [journal,store,boundary]=process.argv.slice(1),hash=b=>createHash('sha256').update(b).digest('hex');
 const read=()=>JSON.parse(fs.readFileSync(store));
 const save=s=>{const tmp=store+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(s));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,store);const parent=fs.openSync(path.dirname(store),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}};
 const ports={authorizeBundle:async()=>{},read:async name=>{const s=read();return s.objects[name]===undefined?null:Buffer.from(s.objects[name],'base64');},putImmutable:async(name,bytes)=>{const s=read();if(s.objects[name]===undefined){s.objects[name]=bytes.toString('base64');save(s);}},compareAndSwapTimestamp:async(expected,bytes)=>{const s=read(),before=s.objects['timestamp.json'];if((before?hash(Buffer.from(before,'base64')):null)!==expected)return false;s.objects['timestamp.json']=bytes.toString('base64');s.commits++;save(s);return true;}};
 const plan={id:'release-2',timestamp:Buffer.from(JSON.stringify({signed:{_type:'timestamp',version:2},signatures:[]})),dependencies:[{name:'2.snapshot.json',bytes:Buffer.from('controlled signed dependency fixture')}]};
 const result=await publishMetadataTransaction(journal,plan,ports,point=>{if(point===boundary)process.kill(process.pid,'SIGKILL');});console.log(JSON.stringify(result));`;
  for (const boundary of [
    "intent-durable",
    "dependency-written",
    "dependencies-verified",
    "commit-intent-durable",
    "timestamp-cas-returned",
    "published-durable",
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-kill-")),
      journal = path.join(dir, "journal"),
      store = path.join(dir, "store");
    try {
      initializePublicationJournal(journal);
      fs.writeFileSync(
        store,
        JSON.stringify({
          objects: { "timestamp.json": timestamp(1).toString("base64") },
          commits: 0,
        }),
      );
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", source, journal, store, boundary],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(child.signal, "SIGKILL", child.stderr);
      const resumed = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", source, journal, store, "none"],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).status, "published");
      const final = JSON.parse(fs.readFileSync(store));
      assert.equal(final.commits, 1);
      assert.deepEqual(
        Buffer.from(final.objects["timestamp.json"], "base64"),
        timestamp(2),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
