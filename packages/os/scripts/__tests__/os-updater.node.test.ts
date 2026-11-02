// The A/B update client: its real classes on the host JVM, its privileged allowlist, and one
// manifest from channel-manifest.mjs through a real Ed25519 signature into ChannelManifest. These
// are host checks: Soong, SELinux, update_engine and the phone stay device evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { channelManifest } from "../android/channel-manifest.mjs";
import { privappPermissions } from "../android/sense-listener.mjs";
import {
  otaPackage,
  PREVIOUS,
  RELEASE,
} from "../android/updater-fixtures/ota-package.mjs";

const updater = fileURLToPath(
  new URL("../../android/updater/", import.meta.url),
);
const fixtures = fileURLToPath(
  new URL("../android/updater-fixtures/", import.meta.url),
);
const source = path.join(updater, "src/ai/elizaos/updater");
const sources = fs.readdirSync(source).map((name) => path.join(source, name));
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const platform = [
  process.env.ANDROID_HOME,
  path.join(os.homedir(), "Library/Android/sdk"),
  path.join(os.homedir(), "Android/Sdk"),
]
  .filter(Boolean)
  .map((sdk) => path.join(sdk, "platforms/android-36/android.jar"))
  .find((jar) => fs.existsSync(jar));

/** Writes the fakes `include` selects, compiles them with the given files, returns the fakes dir. */
function fakes(directory, include = () => true) {
  const parts = fs
    .readFileSync(path.join(fixtures, "platform-fakes.java.txt"), "utf8")
    .split(/^\/\/ file: (.+)$/m);
  const written = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (!include(parts[i])) continue;
    const file = path.join(directory, parts[i]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, parts[i + 1]);
    written.push(file);
  }
  return written;
}

function hostJvm(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "os-updater-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const classes = path.join(directory, "classes");
  execFileSync(
    java("javac"),
    [
      "--release",
      "11",
      "-d",
      classes,
      ...fakes(path.join(directory, "fakes")),
      ...sources,
      path.join(fixtures, "ChannelManifestTest.java"),
      path.join(fixtures, "UpdateFlowTest.java"),
    ],
    { timeout: 60000 },
  );
  return (name, args = []) =>
    execFileSync(java("java"), ["-cp", classes, name, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
}

test("the manifest rules and the job, restart and status flows pass on the host JVM", (t) => {
  const run = hostJvm(t);
  assert.match(run("ai.elizaos.updater.ChannelManifestTest"), /^PASS \d+/);
  assert.match(run("ai.elizaos.updater.UpdateFlowTest"), /^PASS \d+/);
});

test("the updater compiles against the Android 36 API", {
  skip: !platform,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "os-updater-sdk-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  execFileSync(
    java("javac"),
    [
      "--release",
      "21",
      "-cp",
      platform,
      "-d",
      path.join(directory, "classes"),
      ...fakes(path.join(directory, "fakes"), (name) =>
        /^(android\/os\/UpdateEngine|ai\/elizaos\/updater\/R)/.test(name),
      ),
      ...sources,
    ],
    { timeout: 60000 },
  );
});

test("a signed channel-manifest.mjs output reaches ChannelManifest", async (t) => {
  const run = hostJvm(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "os-updater-trip-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = await channelManifest({
    channel: "beta",
    version: "0.1.0",
    sequence: 3,
    baseUrl: "https://updates.example/stallion/0.1.0",
    otas: [
      otaPackage(directory, "ota.zip"),
      otaPackage(directory, "delta.zip", { pre: PREVIOUS }),
    ],
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const key = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const decide = (rolloutPercent, fingerprint, installId = "install") => {
    const bytes = Buffer.from(
      `${JSON.stringify({ ...manifest, rolloutPercent }, null, 2)}\n`,
    );
    const file = path.join(directory, "manifest.json");
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(`${file}.sig`, crypto.sign(null, bytes, privateKey));
    return run("ai.elizaos.updater.ChannelManifestTest", [
      file,
      `${file}.sig`,
      key,
      "beta",
      "stallion",
      fingerprint,
      String((manifest.buildDateUtc - 1) * 1000),
      installId,
    ]).trim();
  };
  const [full, delta] = manifest.updates;
  assert.equal(
    decide(100, RELEASE.replace("/42:", "/40:")),
    [
      full.url,
      full.payload.offset,
      full.payload.size,
      [...full.payload.properties, "NETWORK_ID=7"].join("&"),
    ].join("|"),
  );
  assert.equal(decide(100, PREVIOUS).split("|")[0], delta.url);
  // The bucket the writer's runbook defines, computed outside the Java under test.
  const bucket =
    crypto
      .createHash("sha256")
      .update("install0.1.0")
      .digest()
      .readUInt32BE(0) % 100;
  assert.equal(decide(bucket, PREVIOUS), "none");
  if (bucket < 100) assert.notEqual(decide(bucket + 1, PREVIOUS), "none");
});

test("the privileged allowlist is exactly the privileged permissions the client requests", () => {
  const read = (name) => fs.readFileSync(path.join(updater, name), "utf8");
  const requested = [
    ...read("AndroidManifest.xml").matchAll(
      /<uses-permission android:name="([^"]+)"/g,
    ),
  ].map((row) => row[1]);
  const privileged = [
    "android.permission.READ_PRIVILEGED_PHONE_STATE",
    "android.permission.REBOOT",
  ];
  // Under privapp enforcement a requested privileged permission with no entry stops system_server,
  // so a new permission here must be a deliberate change to this list.
  assert.deepEqual(requested.toSorted(), [
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.INTERNET",
    "android.permission.POST_NOTIFICATIONS",
    ...privileged,
    "android.permission.RECEIVE_BOOT_COMPLETED",
  ]);
  assert.deepEqual(
    privappPermissions(read("privapp-permissions.xml"), "ai.elizaos.updater"),
    privileged,
  );
});
