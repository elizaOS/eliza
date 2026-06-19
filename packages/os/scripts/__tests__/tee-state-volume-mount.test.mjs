// Fail-closed mount-hook tests for the attestation-bound sealed state volume
// (plan §3.5a; OS half of the agent ↔ OS sealed-volume contract).
//
// The hook obtains the volume key through the agent contract
// (packages/agent/src/services/tee-sealed-volume.ts `unsealStateVolumeKey`,
// injected here as `unsealKey`) and drives `cryptsetup luksOpen` + `mount`. The
// security property under test is the OS-side fail-closed behavior:
//
//   1. On a RELEASED key, the hook invokes cryptsetup luksOpen with the key on
//      stdin, then mounts the mapper device.
//   2. On a WITHHELD key (the agent contract rejects), the hook makes NO
//      cryptsetup/mount call and surfaces the rejection (no host-readable
//      fallback).
//   3. On a key-release THROW (boot gate blocks secrets / untrusted decision),
//      the hook refuses to mount.
//   4. A "successful" release that is not a 32-byte hex key is itself refused
//      before any cryptsetup call.
//
// Real dm-crypt unlock needs the confidential guest (BLOCKED on hardware); the
// key-binding + fail-closed logic is what is tested locally via an injected
// runner so no real device is touched.
//
// Runner (canonical for OS scripts; bun test is unstable for these .mjs):
//   node --test packages/os/scripts/__tests__/tee-state-volume-mount.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mountSealedStateVolume } from "../tee-state-volume-mount.mjs";

const RELEASED_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";

function recordingRunner() {
  const calls = [];
  return {
    calls,
    run: async ({ command, args, keyMaterialHex }) => {
      calls.push({ command, args, keyMaterialHex });
    },
  };
}

const baseConfig = {
  cryptDevice: "/dev/vdb",
  mapperName: "eliza_state",
  mountPoint: "/home/eliza/.milady",
};

test("mounts on a released key: luksOpen with key on stdin, then mount", async () => {
  const runner = recordingRunner();
  const mapperPath = await mountSealedStateVolume({
    ...baseConfig,
    unsealKey: async () => ({ keyMaterialHex: RELEASED_KEY }),
    runCryptsetup: runner.run,
  });

  assert.equal(mapperPath, "/dev/mapper/eliza_state");
  assert.equal(runner.calls.length, 2);

  const [open, mount] = runner.calls;
  assert.equal(open.command, "cryptsetup");
  assert.deepEqual(open.args, [
    "--key-file=-",
    "luksOpen",
    "/dev/vdb",
    "eliza_state",
  ]);
  // The key is piped on stdin to luksOpen — never in argv.
  assert.equal(open.keyMaterialHex, RELEASED_KEY);
  assert.ok(!open.args.includes(RELEASED_KEY), "key must not appear in argv");

  assert.equal(mount.command, "mount");
  assert.deepEqual(mount.args, ["/dev/mapper/eliza_state", "/home/eliza/.milady"]);
  // No key on stdin for the mount step.
  assert.equal(mount.keyMaterialHex, "");
});

test("REFUSES to mount when the key is withheld: no cryptsetup call (fail-closed)", async () => {
  const runner = recordingRunner();
  await assert.rejects(
    () =>
      mountSealedStateVolume({
        ...baseConfig,
        // The agent contract rejects: e.g. release decision not trusted.
        unsealKey: async () => {
          throw new Error(
            "state-volume key release denied: measurement-mismatch",
          );
        },
        runCryptsetup: runner.run,
      }),
    /key release denied/,
  );
  // The load-bearing assertion: the volume was never opened or mounted.
  assert.equal(runner.calls.length, 0, "no cryptsetup/mount on withheld key");
});

test("refuses to mount when the boot gate blocks secrets (unseal throws)", async () => {
  const runner = recordingRunner();
  await assert.rejects(
    () =>
      mountSealedStateVolume({
        ...baseConfig,
        unsealKey: async () => {
          throw new Error(
            "state-volume key release refused: TEE boot gate blocks secrets",
          );
        },
        runCryptsetup: runner.run,
      }),
    /boot gate blocks secrets/,
  );
  assert.equal(runner.calls.length, 0);
});

test("refuses when a 'successful' release is not a 32-byte hex key (no cryptsetup call)", async () => {
  const runner = recordingRunner();
  await assert.rejects(
    () =>
      mountSealedStateVolume({
        ...baseConfig,
        unsealKey: async () => ({ keyMaterialHex: "deadbeef" }),
        runCryptsetup: runner.run,
      }),
    /not 32 bytes/,
  );
  assert.equal(runner.calls.length, 0, "garbage key must not reach cryptsetup");
});

test("does not mount if mount fails after a successful luksOpen", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      mountSealedStateVolume({
        ...baseConfig,
        unsealKey: async () => ({ keyMaterialHex: RELEASED_KEY }),
        runCryptsetup: async ({ command, args, keyMaterialHex }) => {
          calls.push({ command, args, keyMaterialHex });
          if (command === "mount") {
            throw new Error("mount: unknown filesystem type");
          }
        },
      }),
    /unknown filesystem type/,
  );
  // luksOpen ran, mount was attempted and failed; the error surfaces.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "cryptsetup");
  assert.equal(calls[1].command, "mount");
});

test("rejects an invalid config before touching the key-release path", async () => {
  let unsealCalled = false;
  await assert.rejects(
    () =>
      mountSealedStateVolume({
        ...baseConfig,
        cryptDevice: "",
        unsealKey: async () => {
          unsealCalled = true;
          return { keyMaterialHex: RELEASED_KEY };
        },
        runCryptsetup: async () => {},
      }),
    /cryptDevice must be a non-empty string/,
  );
  assert.equal(unsealCalled, false);
});
