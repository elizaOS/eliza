#!/usr/bin/env bash
# fetch-cuttlefish-prebuilt-riscv64.sh
#
# Download a prebuilt aosp_cf_riscv64_phone Cuttlefish image bundle and the
# matching cvd-host_package from the public Android CI
# (ci.android.com / androidbuildinternal.googleapis.com).
#
# Builds on this host with ~300-400 GB of free disk and ~16h of compile time
# are infeasible here (only 32 GB free on /). The prebuilt route lets us boot
# the same riscv64 guest as a from-source build using ~3 GB of staging space.
#
# Default target:
#   branch  = aosp-android-latest-release
#   target  = aosp_cf_riscv64_phone-userdebug
#   buildId = picked automatically from the latest green build via the
#             androidbuildinternal API.
#
# Output layout (DEST_DIR / <build-id>/):
#   BUILD_INFO
#   kernel_version.txt
#   aosp_cf_riscv64_phone-img-<bid>.zip       (~780 MiB, system+vendor+boot+...)
#   cvd-host_package.tar.gz                    (~710 MiB, AARCH64 host binaries)
#   cvd-host_package-x86_64.tar.gz             (optional, --with-x86_64-host)
#
# The riscv64 phone build does NOT ship native-riscv64 host binaries; the guest
# is always run under qemu. Use cvd-host_package-x86_64.tar.gz on x86_64 hosts
# (the default `.tar.gz` ships aarch64 binaries for ARM hosts).
#
# Usage:
#   fetch-cuttlefish-prebuilt-riscv64.sh [--dest=DIR] [--branch=BRANCH]
#                                        [--target=TARGET] [--build-id=BID]
#                                        [--with-x86_64-host]
#
# Notes:
#   - On x86_64 dev hosts, the riscv64 guest is executed under qemu via the
#     "cvd-host_package-x86_64.tar.gz" archive (pass --with-x86_64-host).
#   - On native riscv64 hosts, "cvd-host_package.tar.gz" is the right one.
#   - MD5s come from the build manifest at fetch time; mismatches abort.
#
set -euo pipefail

DEFAULT_DEST="${HOME}/.local/cuttlefish/images/riscv64"
DEFAULT_BRANCH="aosp-android-latest-release"
DEFAULT_TARGET="aosp_cf_riscv64_phone-userdebug"

dest="${DEFAULT_DEST}"
branch="${DEFAULT_BRANCH}"
target="${DEFAULT_TARGET}"
explicit_bid=""
with_x86_64_host=0

usage() {
	sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--dest=*)             dest="${1#*=}";;
		--branch=*)           branch="${1#*=}";;
		--target=*)           target="${1#*=}";;
		--build-id=*)         explicit_bid="${1#*=}";;
		--with-x86_64-host)   with_x86_64_host=1;;
		--help|-h)            usage; exit 0;;
		*) echo "unknown option: $1" >&2; usage; exit 2;;
	esac
	shift
done

API_BASE="https://androidbuildinternal.googleapis.com/android/internal/build/v3"

if [ -z "${explicit_bid}" ]; then
	echo "[fetch] querying latest build for ${branch} / ${target}"
	bid_json=$(curl -fsS "${API_BASE}/builds?branch=${branch}&buildType=submitted&maxResults=1&successful=true&target=${target}")
	bid=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['builds'][0]['buildId'])" "${bid_json}")
else
	bid="${explicit_bid}"
fi

echo "[fetch] using build-id ${bid}"

stage="${dest}/${bid}"
mkdir -p "${stage}"

echo "[fetch] enumerating artifacts"
artifacts_json=$(curl -fsS "${API_BASE}/builds/${bid}/${target}/attempts/latest/artifacts?maxResults=500")

python3 - <<'PY' "${artifacts_json}" "${bid}" "${stage}" "${target}" "${with_x86_64_host}"
import json
import os
import sys
import hashlib
import time
import urllib.request

data = json.loads(sys.argv[1])
bid = sys.argv[2]
stage = sys.argv[3]
target = sys.argv[4]
include_x86_64_host = sys.argv[5] == "1"

wanted = {
    "BUILD_INFO",
    "kernel_version.txt",
    f"aosp_cf_riscv64_phone-img-{bid}.zip",
    "cvd-host_package.tar.gz",
}
if include_x86_64_host:
    wanted.add("cvd-host_package-x86_64.tar.gz")

by_name = {a.get("name"): a for a in data.get("artifacts", [])}
missing = sorted(wanted - by_name.keys())
if missing:
    print(f"[fetch] ERROR missing artifacts on build {bid}: {missing}", file=sys.stderr)
    sys.exit(3)

manifest_path = os.path.join(stage, "MANIFEST.json")
manifest = {"buildId": bid, "target": target, "artifacts": {}}
for name in sorted(wanted):
    art = by_name[name]
    manifest["artifacts"][name] = {
        "size": art.get("size"),
        "md5": art.get("md5"),
        "crc32": art.get("crc32"),
    }

def download(name, info):
    url = f"https://ci.android.com/builds/submitted/{bid}/{target}/latest/raw/{name}"
    dest = os.path.join(stage, name)
    if os.path.exists(dest):
        h = hashlib.md5(open(dest, "rb").read()).hexdigest() if int(info.get("size", 0)) < 5_000_000 else None
        if h and info.get("md5") == h:
            print(f"[fetch] {name}: already present (md5 verified)")
            return
        if int(info.get("size", 0)) >= 5_000_000:
            print(f"[fetch] {name}: already present (size match, skipping rehash)")
            return
    print(f"[fetch] GET {name} ({int(info.get('size', 0))/1e6:.1f} MB)")
    tmp = dest + ".part"
    md5 = hashlib.md5()
    start = time.monotonic()
    got = 0
    total = int(info.get("size", 0))
    last = start
    with urllib.request.urlopen(url, timeout=120) as r:
        with open(tmp, "wb") as f:
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                md5.update(chunk)
                got += len(chunk)
                now = time.monotonic()
                if now - last > 10 or got == total:
                    rate = got / max(now - start, 1e-6) / (1024 * 1024)
                    pct = (got / total * 100) if total else 0
                    print(f"        {got/1e6:8.1f} / {total/1e6:8.1f} MB ({pct:5.1f}%) @ {rate:5.1f} MB/s",
                          flush=True)
                    last = now
    digest = md5.hexdigest()
    expected = info.get("md5")
    if expected and expected != digest:
        os.unlink(tmp)
        raise SystemExit(f"[fetch] MD5 mismatch for {name}: expected {expected}, got {digest}")
    os.replace(tmp, dest)
    print(f"        md5 {digest} OK")

for name in sorted(wanted, key=lambda n: (by_name[n].get("size") or 0)):
    download(name, by_name[name])

with open(manifest_path, "w") as f:
    json.dump(manifest, f, indent=2, sort_keys=True)
print(f"[fetch] manifest written: {manifest_path}")
PY

echo "[fetch] complete. Contents:"
ls -la "${stage}"
