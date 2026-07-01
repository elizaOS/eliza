#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
firemarshal="$repo_dir/external/chipyard/software/firemarshal"
workload="$repo_dir/sw/firemarshal/eliza-e1-ap-benchmarks.json"
workload_dir="$repo_dir/sw/firemarshal/eliza-e1-ap-benchmarks"
tool_out="$workload_dir/bin"
build_dir="$repo_dir/build/eliza-e1-ap-benchmarks"
wrapper_bin="$repo_dir/build/firemarshal-toolchain-bin"
deb_tool_bin="$repo_dir/external/riscv64-linux-gnu/usr/bin"
deb_tool_lib="$repo_dir/external/riscv64-linux-gnu/usr/lib/x86_64-linux-gnu"
image_dir="$firemarshal/images/firechip/eliza-e1-ap-benchmarks"
payload="$image_dir/eliza-e1-ap-benchmarks-bin-nodisk"
freshness_manifest="$image_dir/payload_freshness_manifest.json"
linux_boot_evidence="$repo_dir/build/evidence/cpu_ap/eliza_e1_linux_boot.log"
generated_manifest="$repo_dir/build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json"

mkdir -p "$tool_out" "$build_dir"

path_value="$wrapper_bin:$repo_dir/build/tool-wrappers:$repo_dir/tools/bin:$deb_tool_bin:$PATH"
if [ -d "$deb_tool_lib" ]; then
	LD_LIBRARY_PATH="$deb_tool_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
	export LD_LIBRARY_PATH
fi
PATH="$path_value"
export PATH

cc="${RISCV64_LINUX_CC:-riscv64-unknown-linux-gnu-gcc}"

ELIZA_REPO_DIR="$repo_dir" \
	ELIZA_AP_BENCHMARKS_LINUX_BOOT_EVIDENCE="$linux_boot_evidence" \
	ELIZA_AP_BENCHMARKS_GENERATED_MANIFEST="$generated_manifest" \
	python3 - <<'PY'
import datetime as dt
import hashlib
import os
import re
from pathlib import Path

repo = Path(os.environ["ELIZA_REPO_DIR"]).resolve()
linux_boot = Path(os.environ["ELIZA_AP_BENCHMARKS_LINUX_BOOT_EVIDENCE"]).resolve()
generated_manifest = Path(os.environ["ELIZA_AP_BENCHMARKS_GENERATED_MANIFEST"]).resolve()


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(repo))
    except ValueError:
        return str(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def marker(text: str, name: str) -> str | None:
    match = re.search(rf"^eliza-evidence: {re.escape(name)}=(.+)$", text, re.M)
    return match.group(1).strip() if match else None


def parse_utc(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


problems = []
if not generated_manifest.is_file():
    problems.append(f"missing generated manifest: {rel(generated_manifest)}")
if not linux_boot.is_file():
    problems.append(f"missing accepted linux-boot transcript: {rel(linux_boot)}")
if not problems:
    text = linux_boot.read_text(encoding="utf-8", errors="ignore")
    expected_manifest = rel(generated_manifest)
    expected_sha = sha256(generated_manifest)
    if "eliza-evidence: status=PASS" not in text:
        problems.append(f"{rel(linux_boot)} is not accepted PASS evidence")
    if marker(text, "generated_manifest") != expected_manifest:
        problems.append(f"{rel(linux_boot)} is not bound to {expected_manifest}")
    if marker(text, "generated_manifest_sha256") != expected_sha:
        problems.append(f"{rel(linux_boot)} generated_manifest_sha256 is stale")
    if parse_utc(marker(text, "intake_utc")) is None:
        problems.append(f"{rel(linux_boot)} is missing a valid intake_utc marker")
if problems:
    print("STATUS: BLOCKED firemarshal.eliza_e1_ap_benchmarks_payload")
    for problem in problems:
        print("  - " + problem)
    print("  - run linux-boot intake before building the AP benchmark payload")
    raise SystemExit(2)
PY

if ! command -v "$cc" >/dev/null 2>&1; then
	printf 'STATUS: BLOCKED firemarshal.eliza_e1_ap_benchmarks_payload\n'
	printf '  - missing RV64 Linux compiler: %s\n' "$cc"
	exit 2
fi

printf 'Building AP benchmark target tools with %s\n' "$cc"

"$cc" -O2 -static -o "$tool_out/ap-bench-lite" "$workload_dir/ap-bench-lite.c"
chmod 0755 "$tool_out/ap-bench-lite"

# Single-item loop is intentional; the pattern allows adding more tools without restructuring
# shellcheck disable=SC2043
for tool in ap-bench-lite; do
	if ! file "$tool_out/$tool" | grep -q 'RISC-V'; then
		printf 'STATUS: BLOCKED firemarshal.eliza_e1_ap_benchmarks_payload\n'
		printf '  - non-RISC-V target tool: %s\n' "$tool_out/$tool"
		file "$tool_out/$tool"
		exit 2
	fi
done

missing_python=""
for module in humanfriendly doit git yaml psutil; do
	if ! python3 -c "import $module" >/dev/null 2>&1; then
		missing_python="$missing_python $module"
	fi
done
if [ -n "$missing_python" ]; then
	printf 'STATUS: BLOCKED firemarshal.eliza_e1_ap_benchmarks_payload\n'
	printf '  - missing Python modules:%s\n' "$missing_python"
	printf '  - benchmark tools are built, but FireMarshal cannot run yet\n'
	exit 2
fi

cd "$firemarshal"
marshal_attempts="${ELIZA_AP_BENCHMARKS_MARSHAL_ATTEMPTS:-6}"
marshal_retry_sleep="${ELIZA_AP_BENCHMARKS_MARSHAL_RETRY_SLEEP_SECONDS:-20}"
marshal_log="$build_dir/marshal-attempt.log"
attempt=1
while :; do
	if ./marshal --workdir example-workloads -v -d build "$workload" >"$marshal_log" 2>&1; then
		cat "$marshal_log"
		break
	else
		status=$?
	fi
	cat "$marshal_log"
	if [ "$attempt" -ge "$marshal_attempts" ] || ! grep -q 'Resource temporarily unavailable' "$marshal_log"; then
		exit "$status"
	fi
	printf 'FireMarshal marshaldb is locked; retrying AP benchmark workload build (%s/%s) after %ss\n' \
		"$attempt" "$marshal_attempts" "$marshal_retry_sleep"
	attempt=$((attempt + 1))
	sleep "$marshal_retry_sleep"
done

	ELIZA_REPO_DIR="$repo_dir" \
	ELIZA_AP_BENCHMARKS_PAYLOAD="$payload" \
	ELIZA_AP_BENCHMARKS_FRESHNESS_MANIFEST="$freshness_manifest" \
	ELIZA_AP_BENCHMARKS_LINUX_BOOT_EVIDENCE="$linux_boot_evidence" \
	ELIZA_AP_BENCHMARKS_GENERATED_MANIFEST="$generated_manifest" \
	python3 - <<'PY'
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

repo = Path(os.environ["ELIZA_REPO_DIR"]).resolve()
payload = Path(os.environ["ELIZA_AP_BENCHMARKS_PAYLOAD"]).resolve()
manifest = Path(os.environ["ELIZA_AP_BENCHMARKS_FRESHNESS_MANIFEST"]).resolve()
linux_boot = Path(os.environ["ELIZA_AP_BENCHMARKS_LINUX_BOOT_EVIDENCE"]).resolve()
generated_manifest = Path(os.environ["ELIZA_AP_BENCHMARKS_GENERATED_MANIFEST"]).resolve()
workload_dir = repo / "sw/firemarshal/eliza-e1-ap-benchmarks"
inputs = [
    repo / "scripts/build_firemarshal_eliza_ap_benchmarks_payload.sh",
    repo / "sw/firemarshal/eliza-e1-ap-benchmarks.json",
    workload_dir / "eliza-e1-ap-benchmarks-br-trim",
    workload_dir / "eliza-e1-ap-benchmarks-kfrag",
    workload_dir / "eliza-e1-ap-benchmarks.sh",
    workload_dir / "ap-bench-lite.c",
    workload_dir / "lat_mem_rd.c",
    workload_dir / "ufs-dram-contention.fio",
    workload_dir / "bin/ap-bench-lite",
    workload_dir / "bin/coremark",
    workload_dir / "bin/stream_c.exe",
    workload_dir / "bin/lat_mem_rd",
    workload_dir / "bin/fio",
]


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(repo))
    except ValueError:
        return str(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def marker(text: str, name: str) -> str | None:
    import re

    match = re.search(rf"^eliza-evidence: {re.escape(name)}=(.+)$", text, re.M)
    return match.group(1).strip() if match else None


missing = [rel(path) for path in inputs if not path.is_file()]
if not payload.is_file():
    missing.append(rel(payload))
if not linux_boot.is_file():
    missing.append(rel(linux_boot))
if not generated_manifest.is_file():
    missing.append(rel(generated_manifest))
if missing:
    print("STATUS: BLOCKED firemarshal.eliza_e1_ap_benchmarks_payload")
    print("  - cannot write freshness sidecar; missing input(s): " + ", ".join(missing))
    raise SystemExit(2)

linux_boot_text = linux_boot.read_text(encoding="utf-8", errors="ignore")
linux_intake_utc = marker(linux_boot_text, "intake_utc")
linux_generated_manifest_sha = marker(linux_boot_text, "generated_manifest_sha256")

manifest.parent.mkdir(parents=True, exist_ok=True)
manifest.write_text(
    json.dumps(
        {
            "schema": "eliza.firemarshal_ap_benchmarks_payload_freshness.v1",
            "generated_utc": dt.datetime.now(dt.UTC)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "payload": {
                "path": rel(payload),
                "sha256": sha256(payload),
            },
            "accepted_linux_boot": {
                "path": rel(linux_boot),
                "sha256": sha256(linux_boot),
                "intake_utc": linux_intake_utc,
                "generated_manifest_sha256": linux_generated_manifest_sha,
            },
            "generated_manifest": {
                "path": rel(generated_manifest),
                "sha256": sha256(generated_manifest),
            },
            "inputs": {
                rel(path): {
                    "sha256": sha256(path),
                }
                for path in inputs
            },
        },
        indent=2,
        sort_keys=True,
    )
    + "\n",
    encoding="utf-8",
)
print("STATUS: PASS firemarshal.eliza_e1_ap_benchmarks_payload")
print(f"  payload: {rel(payload)}")
print(f"  freshness_manifest: {rel(manifest)}")
PY
