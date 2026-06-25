#!/usr/bin/env node
// Attestation-bound sealed state-volume mount hook (plan §3.5a; OS half of the
// agent ↔ OS sealed-volume contract).
//
// The dm-crypt/LUKS2 state volume that backs ELIZA_STATE_DIR (the
// agent-session secret scope) must NOT be unlocked with a host-readable key
// (dstack LUKS2 advisory GHSA-jxq2-hpw3-m5wf; agent plan §5.5). Its key is
// released ONLY after a passing attestation and is bound to the measured
// agent/policy/device identity. A tampered OS/agent derives a DIFFERENT key,
// the volume simply will not decrypt, and the negative path is enforced by
// data unavailability — not by a flag that can be patched out.
//
// SCOPE (OS half): this hook obtains the attestation-released volume key
// through the agent contract (unsealStateVolumeKey: a 32-byte hex value gated
// on a passing attestation), then drives `cryptsetup luksOpen` + `mount`. It
// FAILS CLOSED: if the key is withheld (the unseal call throws — boot gate
// blocks secrets, policy does not gate the required measurements, or the
// release decision is not trusted), the hook does NOT open or mount the
// volume, exits non-zero, and never falls back to a host-readable key.
//
// SCOPE (agent half — NOT here): the security-critical attestation→key binding
// lives in packages/agent/src/services/tee-sealed-volume.ts
// (`unsealStateVolumeKey` / `openSealedVolumeMetadata`). This hook integrates
// with it through an injected `unsealKey` function so the fail-closed mount
// logic is unit-testable in memory without hardware.
//
// HARDWARE BOUNDARY (fail-closed): a real dm-crypt unlock requires the
// confidential guest (TDX CVM / E1 CoVE TVM) where the attested key is actually
// released — that is BLOCKED on hardware (plan OS-6/OS-8). What is tested here
// is the key-binding + fail-closed mount logic: on a released key the hook
// invokes cryptsetup with the key piped on stdin; on a withheld key it makes NO
// cryptsetup call at all. Pass an injected `runCryptsetup` (or `--dry-run`) to
// exercise the logic off-hardware.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const STATE_VOLUME_KEY_ID = "state-volume";

/**
 * Drive the sealed-volume mount. Returns the mapper path on success; THROWS
 * (fail-closed) when the key is withheld or any step fails. The caller maps a
 * throw to a non-zero exit and an unmounted volume.
 *
 * @param {object} config
 * @param {() => Promise<{ keyMaterialHex: string }>} config.unsealKey
 *   The agent contract boundary. Resolves to the attestation-released 32-byte
 *   (hex) volume key, or REJECTS when the key is withheld (boot gate blocks
 *   secrets / policy does not gate required measurements / decision not
 *   trusted). Mirrors packages/agent/src/services/tee-sealed-volume.ts
 *   `unsealStateVolumeKey`. Injected so this hook is host-testable.
 * @param {string} config.cryptDevice
 *   Backing block device holding the LUKS2 state volume (e.g. /dev/vdb).
 * @param {string} config.mapperName
 *   dm-crypt mapping name; the unlocked device appears at /dev/mapper/<name>.
 * @param {string} config.mountPoint
 *   Where the unlocked volume is mounted (ELIZA_STATE_DIR).
 * @param {(args: { command: string, args: string[], keyMaterialHex: string }) => Promise<void>} [config.runCryptsetup]
 *   Injected runner for the privileged cryptsetup/mount commands. Defaults to a
 *   real spawn that pipes the key on stdin. Tests inject a recorder so no real
 *   device is touched.
 */
export async function mountSealedStateVolume(config) {
  assertConfig(config);

  // Obtain the attestation-released key. This is the ONLY path to the key: if
  // the agent contract rejects (withheld key), the rejection propagates and the
  // volume is never opened. No fallback, no host-readable key.
  const released = await config.unsealKey();
  const keyMaterialHex = released?.keyMaterialHex;
  if (!/^[a-f0-9]{64}$/.test(String(keyMaterialHex))) {
    // Defensive: the agent contract guarantees a 32-byte hex key on success.
    // A success result that is not a valid key is itself a fail-closed
    // condition — refuse to mount rather than feed garbage to cryptsetup.
    throw new Error(
      "state-volume mount refused: released key material is not 32 bytes (hex).",
    );
  }

  const run = config.runCryptsetup ?? defaultRunCryptsetup;
  const mapperPath = `/dev/mapper/${config.mapperName}`;

  try {
    // luksOpen with the released key piped on stdin (--key-file=-): the key
    // never lands on disk, in argv, in the environment, or in any logger.
    await run({
      command: "cryptsetup",
      args: ["--key-file=-", "luksOpen", config.cryptDevice, config.mapperName],
      keyMaterialHex,
    });
    // Mount the now-unlocked mapper device at the state dir. No key on stdin.
    await run({
      command: "mount",
      args: [mapperPath, config.mountPoint],
      keyMaterialHex: "",
    });
  } finally {
    // The released key is not persisted by this hook. Drop our only reference.
    // (Zeroization of the in-RAM key buffer is the agent side's job, §3.2/§3.5;
    // here we hold only the hex string, which we no longer reference.)
  }

  return mapperPath;
}

function assertConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("mountSealedStateVolume requires a config object.");
  }
  if (typeof config.unsealKey !== "function") {
    throw new Error("config.unsealKey must be a function (agent contract).");
  }
  for (const field of ["cryptDevice", "mapperName", "mountPoint"]) {
    if (typeof config[field] !== "string" || config[field].trim() === "") {
      throw new Error(`config.${field} must be a non-empty string.`);
    }
  }
}

/**
 * Real privileged runner: spawn the command and pipe the key on stdin so it is
 * never visible in argv/env/logs. Rejects on a non-zero exit. Used only in the
 * confidential guest; tests inject their own runner.
 */
function defaultRunCryptsetup({ command, args, keyMaterialHex }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}.`));
      }
    });
    if (keyMaterialHex) {
      // cryptsetup --key-file=- reads the raw passphrase bytes from stdin.
      child.stdin.write(keyMaterialHex);
    }
    child.stdin.end();
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // A real run requires the confidential guest's in-domain attestation agent
  // and a real LUKS2 device — BLOCKED on hardware (plan OS-6/OS-8). The CLI
  // entrypoint fails closed: it does not ship a host-readable fallback key.
  console.error(
    "tee-state-volume-mount: real dm-crypt unseal is BLOCKED on hardware " +
      "(confidential guest in-domain attestation; gates tdx-cvm-boot-smoke / " +
      "tdx-unseal-negative). This module exports mountSealedStateVolume() whose " +
      "fail-closed key-binding logic is unit-tested off-hardware:\n" +
      "  node --test packages/os/scripts/__tests__/tee-state-volume-mount.test.mjs",
  );
  if (args["dry-run"] !== true) {
    process.exit(2);
  }
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
