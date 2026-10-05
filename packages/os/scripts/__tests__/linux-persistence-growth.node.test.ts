import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL(
    "../../linux/elizaos/mkosi/mkosi.extra/usr/libexec/elizaos-grow-persistent",
    import.meta.url,
  ),
);

// Emulate the inventory and block-device predicate; no host device is accessed.
// Each failing query emits otherwise usable output before returning failure.
const fixture = String.raw`
findmnt() { printf '%s\n' /dev/vda2; }
readlink() { printf '%s\n' /dev/vda2; }
[() {
  if builtin [ "$1" = -b ]; then return 0; fi
  builtin [ "$@"
}
lsblk() {
  local query
  if builtin [ "$EMPTY_GEOMETRY" = 1 ] && builtin [ "$2" = START,SIZE ]; then return 0; fi
  case "$*" in
    '-ndo PKNAME /dev/vda2') query=parent; printf '%s\n' "$PARENT" ;;
    '-nrpo NAME,PARTTYPE,PARTLABEL /dev/vda')
      query=home
      printf '%s\n' '/dev/vda4 933ac7e1-2eb4-4f13-b844-0e14e2aef915 elizaos-home' ;;
    '-nrpo PARTTYPE /dev/vda')
      query=types
      printf '%s\n' 933ac7e1-2eb4-4f13-b844-0e14e2aef915
      if builtin [ "$DUPLICATE" = 1 ]; then
        printf '%s\n' 933ac7e1-2eb4-4f13-b844-0e14e2aef915
      fi ;;
    '-bnro START,SIZE /dev/vda4') query=home_geometry; printf '%s\n' '2048 1048576' ;;
    '-bnro START,SIZE /dev/vda')
      query=disk_geometry; printf '%s\n' '2048 1048576'
      if builtin [ "$NOT_LAST" = 1 ]; then printf '%s\n' '4096 1048576'; fi ;;
    *) echo "unexpected inventory query: $*" >&2; return 99 ;;
  esac
  if builtin [ "$FAIL_QUERY" = "$query" ]; then return 17; fi
}
systemd-repart() { echo MUTATION; }
udevadm() { echo SETTLED; }
. "$1"
`;

function run(overrides = {}) {
  const result = spawnSync("bash", ["-c", fixture, "fixture", script], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      EMPTY_GEOMETRY: "0",
      PARENT: "vda",
      DUPLICATE: "0",
      NOT_LAST: "0",
      FAIL_QUERY: "",
      ...overrides,
    },
  });
  assert.equal(result.error, undefined);
  return result;
}

test("persistent growth refuses failed inventory even with valid partial output", () => {
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /MUTATION\nSETTLED/);
  for (const query of [
    "parent",
    "home",
    "types",
    "home_geometry",
    "disk_geometry",
  ]) {
    const result = run({ FAIL_QUERY: query });
    assert.notEqual(result.status, 0, query);
    assert.doesNotMatch(result.stdout, /MUTATION|SETTLED/, query);
  }
});

test("persistent growth refuses ambiguous parents and unsafe home layouts", () => {
  for (const inputs of [
    { PARENT: "vda\nvdb" },
    { DUPLICATE: "1" },
    { NOT_LAST: "1" },
    { EMPTY_GEOMETRY: "1" },
  ]) {
    const result = run(inputs);
    assert.notEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /MUTATION|SETTLED/);
  }
});
