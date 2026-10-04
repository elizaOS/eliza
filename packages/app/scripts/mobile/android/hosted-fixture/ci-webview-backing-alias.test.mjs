import { createHostedWebViewProvisioner } from "./webview-provider.mjs";

const { ensureScratchBackingAlias, scratchBackingBytes } =
  createHostedWebViewProvisioner({
    forbiddenPackagePrefixes: ["com.example.consumer."],
  });

import assert from "node:assert/strict";
import test from "node:test";

const fingerprint =
  "Android/sdk_phone64_x86_64/emu64x:15/AE3A.240806.019/12368160:userdebug/test-keys";
function fixture(
  overrides = {},
  initial = "/dev/block/vdc",
  deniedAdmission = 0,
) {
  let alias = initial,
    admissions = 0;
  const calls = [],
    mutations = [];
  const responses = {
    "shell getprop ro.build.fingerprint": fingerprint,
    "shell cat /proc/mounts": "/dev/block/dm-43 /data ext4 rw 0 0\n",
    "shell cat /sys/class/block/dm-43/dm/name": "userdata",
    "shell ls -1 /sys/class/block/dm-43/slaves": "vdc",
    "shell cat /sys/class/block/vdc/dev": "253:32",
    "shell stat -c %t:%T /dev/block/vdc": "fd:20",
    "shell test -b /dev/block/vdc": "",
    "shell readlink -f /dev/block/by-name/vdc": "/dev/block/vdc",
    "shell readlink -f /dev/block/by-name": "/dev/block/by-name",
    ...overrides,
  };
  const run = (...args) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (args[1] === "sh") return alias;
    if (args[1] === "ln") {
      mutations.push(cmd);
      assert.equal(alias, "MISSING");
      assert.equal(cmd, "shell ln -sT /dev/block/vdc /dev/block/by-name/vdc");
      alias = "/dev/block/vdc";
      return "";
    }
    assert.ok(cmd in responses, cmd);
    const value = responses[cmd];
    if (value instanceof Error) throw value;
    return value;
  };
  const admit = () => {
    calls.push("ADMIT");
    admissions++;
    if (admissions === deniedAdmission) throw Error("admission refused");
  };
  return {
    run,
    admit,
    calls,
    mutations,
    reboot: () => {
      alias = "MISSING";
    },
  };
}
const scenario = test;
scenario(
  "missing alias before or after reboot refuses without late repair",
  () => {
    const f = fixture({}, "MISSING");
    assert.throws(() => ensureScratchBackingAlias(f.run, f.admit));
    f.reboot();
    assert.throws(() => ensureScratchBackingAlias(f.run, f.admit));
    assert.equal(f.mutations.length, 0);
  },
);
scenario("preexisting correct alias is verified without mutation", () => {
  const f = fixture({}, "/dev/block/vdc");
  assert.equal(ensureScratchBackingAlias(f.run, f.admit).created, false);
  assert.equal(f.mutations.length, 0);
});
for (const [name, overrides, alias, admission] of [
  ["wrong image", { "shell getprop ro.build.fingerprint": "other" }],
  [
    "non-ext4 data",
    { "shell cat /proc/mounts": "/dev/block/dm-43 /data f2fs rw 0 0" },
  ],
  [
    "ambiguous data mounts",
    {
      "shell cat /proc/mounts":
        "/dev/block/dm-43 /data ext4 rw 0 0\n/dev/block/dm-44 /data ext4 rw 0 0",
    },
  ],
  [
    "wrong mapper name",
    { "shell cat /sys/class/block/dm-43/dm/name": "system" },
  ],
  [
    "multiple physical slaves",
    { "shell ls -1 /sys/class/block/dm-43/slaves": "vdc\nvdd" },
  ],
  [
    "different physical slave",
    { "shell ls -1 /sys/class/block/dm-43/slaves": "vdd" },
  ],
  [
    "wrong physical block number",
    { "shell stat -c %t:%T /dev/block/vdc": "fd:30" },
  ],
  ["non-block node", { "shell test -b /dev/block/vdc": Error("not block") }],
  [
    "redirected alias directory",
    { "shell readlink -f /dev/block/by-name": "/other" },
  ],
  ["wrong alias", {}, "/dev/block/vdd"],
  ["regular existing alias", {}, "NON_SYMLINK"],
  ["initial admission denied", {}, "MISSING", 1],
])
  scenario(`${name} refuses before mutation`, () => {
    const f = fixture(overrides, alias, admission);
    assert.throws(() => ensureScratchBackingAlias(f.run, f.admit));
    assert.equal(f.mutations.length, 0);
  });
scenario("alias drift during re-admission is not overwritten", () => {
  const f = fixture();
  let n = 0;
  const run = (...args) =>
    args[1] === "sh" && ++n === 2 ? "/dev/block/vdd" : f.run(...args);
  assert.throws(() => ensureScratchBackingAlias(run, f.admit));
  assert.equal(f.mutations.length, 0);
});

test("scratch inventory rejects malformed or indented named rows instead of treating them as absent", () => {
  for (const row of [
    "scratch:",
    " scratch : 254:5",
    "\tscratch : 254:5",
    "scratch",
    "scratch: malformed",
  ]) {
    const calls = [];
    assert.throws(
      () =>
        scratchBackingBytes((...args) => {
          calls.push(args.join(" "));
          return `Available Device Mapper Devices:\n${row}\n`;
        }),
      /Malformed scratch mapping/,
    );
    assert.deepEqual(calls, ["shell dmctl list devices"]);
  }
});
