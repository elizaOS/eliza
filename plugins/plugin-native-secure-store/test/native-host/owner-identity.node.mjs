import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifiedOwnerIdentity } from "../../../../packages/agent/native-host/gateway.mjs";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
test("native owner identity has the same bytes as the gateway's verifiedOwnerIdentity", (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "owner-identity-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  const bin = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(
        plugin,
        "android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly/VerifiedOwnerIdentity.java",
      ),
      path.join(plugin, "test/native-host/VerifiedOwnerIdentityTest.java"),
    ],
    { timeout: 60000 },
  );
  const owners = [
    {
      authority: "https://cloud.example",
      userId: 'slash/quote"back\\雪😀',
      organizationId: "org",
    },
    {
      authority: "http://127.0.0.1:8787",
      userId: "user-1",
      organizationId: "Ünïcode ☃ 𝄞  ",
    },
    {
      authority: "https://api.example.test",
      userId: "a,b",
      organizationId: "]",
    },
  ];
  const output = execFileSync(
    bin("java"),
    [
      "-Dfile.encoding=UTF-8",
      "-Dstdout.encoding=UTF-8",
      "-cp",
      classes,
      "ai.eliza.plugins.securestore.nativeonly.VerifiedOwnerIdentityTest",
      ...owners.flatMap((o) => [o.authority, o.userId, o.organizationId]),
    ],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.deepEqual(
    output.trim().split("\n"),
    owners.map(verifiedOwnerIdentity),
  );
  // The vector VerifiedTaskCustodyInstrumentedTest pins on Android.
  assert.equal(
    output.split("\n")[0],
    "cloud-owner-v1:62daffc216635641024e10f1dc368706bc4398090e4331ff7f8413702ed64462",
  );
});
