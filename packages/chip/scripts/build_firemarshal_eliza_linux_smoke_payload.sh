#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
firemarshal="$repo_dir/external/chipyard/software/firemarshal"
workload="${FIREMARSHAL_WORKLOAD:-$repo_dir/sw/firemarshal/eliza-e1-linux-smoke.json}"
workload_dir="$repo_dir/sw/firemarshal/eliza-e1-linux-smoke"
image_dir="$firemarshal/images/firechip/eliza-e1-linux-smoke"
payload="$image_dir/eliza-e1-linux-smoke-bin-nodisk"
freshness_manifest="$image_dir/payload_freshness_manifest.json"
linux_config="$image_dir/linux_config"
wrapper_bin="$repo_dir/build/firemarshal-toolchain-bin"
deb_tool_bin="$repo_dir/external/riscv64-linux-gnu/usr/bin"
deb_tool_lib="$repo_dir/external/riscv64-linux-gnu/usr/lib/x86_64-linux-gnu"
deb_sysroot="$repo_dir/external/riscv64-linux-gnu"
deb_target_sysroot="$deb_sysroot/usr/riscv64-linux-gnu"

mkdir -p "$wrapper_bin"
materialize_usr_include() {
	sysroot="$1"
	fallback_src="${2:-}"
	src="$sysroot/include"
	dst="$sysroot/usr/include"
	if [ ! -d "$src" ]; then
		src="$fallback_src"
	fi
	if [ ! -d "$src" ]; then
		if [ -L "$dst" ]; then
			rm -f "$dst"
			mkdir -p "$dst"
		fi
		return 0
	fi
	if [ -L "$dst" ]; then
		rm -f "$dst"
	fi
	if [ ! -d "$dst" ]; then
		mkdir -p "$dst"
	fi
	cp -a "$src/." "$dst/"
}

normalize_glibc_linker_script() {
	sysroot="$1"
	libc_script="$sysroot/lib/libc.so"
	if [ ! -f "$libc_script" ]; then
		return 0
	fi
	cat >"$libc_script" <<'EOF'
/* GNU ld script
   Use the shared library, but some functions are only in
   the static library, so try that secondarily.  */
OUTPUT_FORMAT(elf64-littleriscv)
GROUP ( libc.so.6 libc_nonshared.a AS_NEEDED ( ld-linux-riscv64-lp64d.so.1 ) )
EOF
}

if [ -d "$deb_target_sysroot/include" ]; then
	mkdir -p "$deb_target_sysroot/usr"
	materialize_usr_include "$deb_target_sysroot"
fi
normalize_glibc_linker_script "$deb_target_sysroot"
for imported_sysroot in "$firemarshal"/boards/default/distros/br/buildroot/output/host/*/sysroot; do
	[ -d "$imported_sysroot" ] || continue
	materialize_usr_include "$imported_sysroot" "$deb_target_sysroot/include"
	normalize_glibc_linker_script "$imported_sysroot"
done
for tool in "$repo_dir"/tools/bin/riscv64-linux-gnu-* "$deb_tool_bin"/riscv64-linux-gnu-*; do
	[ -e "$tool" ] || continue
	base="$(basename -- "$tool")"
	case "$base" in
		riscv64-linux-gnu-gcc|riscv64-linux-gnu-g++|riscv64-linux-gnu-cpp|riscv64-linux-gnu-gfortran)
			;;
		riscv64-linux-gnu-*)
			ln -sf "$tool" "$wrapper_bin/$(printf '%s\n' "$base" | sed 's/^riscv64-linux-gnu-/riscv64-unknown-linux-gnu-/')"
			;;
	esac
done

make_compiler_wrapper() {
	src="$1"
	dst="$2"
	rm -f "$dst"
	cat >"$dst" <<EOF
#!/usr/bin/env sh
set -eu

tool="$src"
sysroot="$deb_sysroot"
libdir="$deb_tool_lib"
export LD_LIBRARY_PATH="\$libdir\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"

if [ "\${1:-}" = "-v" ] && [ "\$#" -eq 1 ]; then
	"\$tool" --sysroot="\$sysroot" -v 2>&1 | sed "s,--with-sysroot=/,--with-sysroot=\$sysroot,g"
	exit 0
fi

exec "\$tool" --sysroot="\$sysroot" "\$@"
EOF
	chmod +x "$dst"
}

if [ -x "$deb_tool_bin/riscv64-linux-gnu-gcc" ]; then
	make_compiler_wrapper "$deb_tool_bin/riscv64-linux-gnu-gcc" "$wrapper_bin/riscv64-unknown-linux-gnu-gcc"
fi
if [ -x "$deb_tool_bin/riscv64-linux-gnu-g++" ]; then
	make_compiler_wrapper "$deb_tool_bin/riscv64-linux-gnu-g++" "$wrapper_bin/riscv64-unknown-linux-gnu-g++"
elif [ -x "$deb_tool_bin/riscv64-linux-gnu-g++-13" ]; then
	make_compiler_wrapper "$deb_tool_bin/riscv64-linux-gnu-g++-13" "$wrapper_bin/riscv64-unknown-linux-gnu-g++"
fi
if [ -x "$deb_tool_bin/riscv64-linux-gnu-cpp" ]; then
	make_compiler_wrapper "$deb_tool_bin/riscv64-linux-gnu-cpp" "$wrapper_bin/riscv64-unknown-linux-gnu-cpp"
fi
if [ -x "$deb_tool_bin/riscv64-linux-gnu-gfortran" ]; then
	make_compiler_wrapper "$deb_tool_bin/riscv64-linux-gnu-gfortran" "$wrapper_bin/riscv64-unknown-linux-gnu-gfortran"
elif [ -x "$deb_tool_bin/riscv64-linux-gnu-gfortran-13" ]; then
	make_compiler_wrapper "$deb_tool_bin/riscv64-linux-gnu-gfortran-13" "$wrapper_bin/riscv64-unknown-linux-gnu-gfortran"
fi

missing_python=""
for module in humanfriendly doit git yaml psutil; do
	if ! python3 -c "import $module" >/dev/null 2>&1; then
		missing_python="$missing_python $module"
	fi
done
if [ -n "$missing_python" ]; then
	printf 'STATUS: BLOCKED firemarshal.eliza_e1_linux_smoke_payload\n'
	printf '  - missing Python modules:%s\n' "$missing_python"
	printf '  - install them in the active Python environment, then rerun this script\n'
	exit 2
fi

if [ ! -x "$wrapper_bin/riscv64-unknown-linux-gnu-gcc" ]; then
	printf 'STATUS: BLOCKED firemarshal.eliza_e1_linux_smoke_payload\n'
	printf '  - missing riscv64 linux gcc wrapper: %s\n' "$wrapper_bin/riscv64-unknown-linux-gnu-gcc"
	exit 2
fi

path_value="$wrapper_bin:$repo_dir/tools/bin:$deb_tool_bin:$PATH"
if [ -d "$deb_tool_lib" ]; then
	LD_LIBRARY_PATH="$deb_tool_lib"
	export LD_LIBRARY_PATH
fi
PATH="$path_value"
export PATH

export ELIZA_REPO_DIR="$repo_dir"
export ELIZA_FIREMARSHAL_PAYLOAD="$payload"
export ELIZA_FIREMARSHAL_FRESHNESS_MANIFEST="$freshness_manifest"
export ELIZA_FIREMARSHAL_LINUX_CONFIG="$linux_config"
export ELIZA_FIREMARSHAL_WORKLOAD="$workload"
export ELIZA_FIREMARSHAL_WORKLOAD_DIR="$workload_dir"
export ELIZA_FIREMARSHAL_BUILDER="$repo_dir/scripts/build_firemarshal_eliza_linux_smoke_payload.sh"
export ELIZA_FIREMARSHAL_WLUTIL_BUILD="$firemarshal/wlutil/build.py"
export FIREMARSHAL_NODISK_BUSYBOX_SH=1
export FIREMARSHAL_NODISK_BUSYBOX_APPLETS="/bin/cat:/bin/echo:/bin/grep:/bin/hostname:/bin/ln:/bin/ls:/bin/mkdir:/bin/mknod:/bin/mount:/bin/rm:/bin/sh:/bin/sync:/bin/umount:/bin/zcat:/sbin/devmem:/sbin/getty:/sbin/init:/sbin/klogd:/sbin/mdev:/sbin/modprobe:/sbin/poweroff:/sbin/start-stop-daemon:/sbin/swapoff:/sbin/swapon:/sbin/sysctl:/sbin/syslogd:/usr/bin/find:/usr/bin/logger:/usr/bin/od:/usr/bin/readlink:/usr/bin/xargs"
export FIREMARSHAL_NODISK_PRUNE_PATHS="/bin/bash:/usr/bin/coreutils:/usr/share/vim:/usr/bin/vim:/usr/bin/vimdiff:/usr/bin/rvim:/usr/bin/view:/usr/bin/ex:/usr/bin/less:/usr/bin/lesskey:/usr/bin/lspci:/usr/bin/setpci:/usr/share/pci.ids.gz:/usr/share/terminfo:/etc/init.d/S01syslogd:/etc/init.d/S02klogd:/etc/init.d/S02sysctl:/etc/init.d/S40network:/usr/share/libmemcached-awesome:/usr/bin/memaslap:/usr/bin/memcapable:/usr/bin/memslap:/usr/bin/memstat:/usr/bin/memcp:/usr/bin/memtouch:/usr/bin/memrm:/usr/bin/memping:/usr/bin/memflush:/usr/bin/memexist:/usr/bin/memerror:/usr/bin/memdump:/usr/bin/memcat:/usr/bin/pcre2test:/usr/bin/pcretest:/usr/bin/pcre2grep:/usr/bin/pcregrep:/usr/lib/libzmq.so:/usr/lib/libzmq.so.5:/usr/lib/libzmq.so.5.2.5:/usr/lib/libzmqpp.so:/usr/lib/libzmqpp.so.4:/usr/lib/libzmqpp.so.4.2.0:/usr/lib/libpcre2-8.so:/usr/lib/libpcre2-8.so.0:/usr/lib/libpcre2-8.so.0.12.0:/usr/lib/libpcre.so:/usr/lib/libpcre.so.1:/usr/lib/libpcre.so.1.2.13:/usr/lib/libpcrecpp.so:/usr/lib/libpcrecpp.so.0:/usr/lib/libpcrecpp.so.0.0.2:/usr/lib/libevent-2.1.so.7:/usr/lib/libevent-2.1.so.7.0.1:/usr/lib/libevent_core-2.1.so.7:/usr/lib/libevent_core-2.1.so.7.0.1:/usr/lib/libevent_extra-2.1.so.7:/usr/lib/libevent_extra-2.1.so.7.0.1:/usr/lib/libreadline.so:/usr/lib/libreadline.so.8:/usr/lib/libreadline.so.8.2:/usr/lib/libhistory.so:/usr/lib/libhistory.so.8:/usr/lib/libhistory.so.8.2:/usr/lib/libncurses.so:/usr/lib/libncurses.so.6:/usr/lib/libncurses.so.6.4:/usr/lib/libform.so:/usr/lib/libform.so.6:/usr/lib/libform.so.6.4:/usr/lib/libmenu.so:/usr/lib/libmenu.so.6:/usr/lib/libmenu.so.6.4:/usr/lib/libpanel.so:/usr/lib/libpanel.so.6:/usr/lib/libpanel.so.6.4:/usr/lib/libapr-1.so:/usr/lib/libapr-1.so.0:/usr/lib/libapr-1.so.0.7.2:/usr/lib/libaprutil-1.so:/usr/lib/libaprutil-1.so.0:/usr/lib/libaprutil-1.so.0.6.3:/usr/lib/libmemcached.so:/usr/lib/libmemcached.so.11:/usr/lib/libmemcached.so.11.0.0:/usr/lib/libmemcachedprotocol.so:/usr/lib/libmemcachedprotocol.so.0:/usr/lib/libmemcachedprotocol.so.0.0.0:/usr/lib/libmemcachedutil.so:/usr/lib/libmemcachedutil.so.2:/usr/lib/libmemcachedutil.so.2.0.0:/usr/lib/libhashkit.so:/usr/lib/libhashkit.so.2:/usr/lib/libhashkit.so.2.0.0:/usr/lib/libpci.so:/usr/lib/libpci.so.3:/usr/lib/libpci.so.3.10.0"
export FIREMARSHAL_NODISK_PRUNE_GLOBS="/lib/*.so*:/usr/lib/*.so*"
export FIREMARSHAL_NODISK_MINIMAL_ROOT=1
export FIREMARSHAL_LINUX_DISABLE_CONFIGS="EFI:EFI_STUB:EFI_PARTITION:EFI_ESRT:EFI_RUNTIME_WRAPPERS:EFI_EARLYCON:RCU_STALL_COMMON"
python3 - <<'PY'
import os
from pathlib import Path

repo = Path(os.environ["ELIZA_REPO_DIR"]).resolve()
payload = Path(os.environ["ELIZA_FIREMARSHAL_PAYLOAD"]).resolve()
manifest = Path(os.environ["ELIZA_FIREMARSHAL_FRESHNESS_MANIFEST"]).resolve()
linux_config = Path(os.environ["ELIZA_FIREMARSHAL_LINUX_CONFIG"]).resolve()
workload = Path(os.environ["ELIZA_FIREMARSHAL_WORKLOAD"]).resolve()
workload_dir = Path(os.environ["ELIZA_FIREMARSHAL_WORKLOAD_DIR"]).resolve()
builder = Path(os.environ["ELIZA_FIREMARSHAL_BUILDER"]).resolve()
wlutil_build = Path(os.environ["ELIZA_FIREMARSHAL_WLUTIL_BUILD"]).resolve()

inputs = [
    builder,
    wlutil_build,
    workload,
    workload_dir / "eliza-e1-linux-smoke-br-trim",
    workload_dir / "eliza-e1-linux-smoke-kfrag",
    workload_dir / "eliza-e1-linux-smoke.sh",
    workload_dir / "build-hwprobe.sh",
    workload_dir / "eliza-e1-linux-smoke-overlay/etc/init.d/S00eliza-e1-linux-smoke",
    workload_dir / "opensbi-eliza_defconfig",
    workload_dir / "eliza-riscv-hwprobe.c",
    workload_dir / "eliza-riscv-hwprobe",
    workload_dir / "e1-npu-ml-smoke",
    repo / "sw/linux/drivers/e1/Kconfig",
    repo / "sw/linux/drivers/e1/Makefile",
    repo / "sw/linux/drivers/e1/e1-dma.c",
    repo / "sw/linux/drivers/e1/e1-npu.c",
    repo / "sw/linux/drivers/e1/e1-npu-uapi.h",
    repo / "sw/linux/drivers/e1/e1_platform_contract.h",
]
optional_inputs = [
    workload_dir / "eliza-skip-unaligned-probe.patch",
    workload_dir / "opensbi-eliza-platform-fast-final.patch",
]
inputs.extend(path for path in optional_inputs if path.exists())


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(repo))
    except ValueError:
        return str(path)


def stale_config_reasons():
    kfrag = workload_dir / "eliza-e1-linux-smoke-kfrag"
    if not linux_config.is_file() or not kfrag.is_file():
        return []
    linux_config_lines = set(linux_config.read_text(encoding="utf-8").splitlines())
    enforced_disabled = {
        "CONFIG_EFI",
        "CONFIG_EFI_STUB",
        "CONFIG_EFI_ESRT",
        "CONFIG_EFI_RUNTIME_WRAPPERS",
        "CONFIG_EFI_EARLYCON",
        "CONFIG_PORTABLE",
        "CONFIG_STRICT_KERNEL_RWX",
        "CONFIG_STRICT_MODULE_RWX",
    }
    kfrag_lines = []
    for line in kfrag.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        if line.startswith("# CONFIG_") and line.endswith(" is not set"):
            symbol = line.split()[1]
            if symbol not in enforced_disabled:
                continue
        elif line.startswith("#"):
            continue
        kfrag_lines.append(line)
    missing = [line for line in kfrag_lines if line not in linux_config_lines]
    if not missing:
        return []
    suffix = "" if len(missing) <= 5 else f", +{len(missing) - 5} more"
    return [f"built linux_config missing {rel(kfrag)} option(s): {', '.join(missing[:5])}{suffix}"]


reasons = stale_config_reasons()
if manifest.is_file() and (not payload.is_file() or not linux_config.is_file()):
    reasons.append("freshness manifest has no matching payload/config artifact")
if payload.is_file():
    payload_mtime = payload.stat().st_mtime
    newer_inputs = [
        rel(path)
        for path in inputs
        if path.is_file() and path.stat().st_mtime > payload_mtime
    ]
    if newer_inputs:
        suffix = "" if len(newer_inputs) <= 6 else f", +{len(newer_inputs) - 6} more"
        reasons.append(f"payload predates input(s): {', '.join(newer_inputs[:6])}{suffix}")

if reasons:
    print("STATUS: STALE firemarshal.eliza_e1_linux_smoke_payload")
    for reason in reasons:
        print(f"  - {reason}")
    for artifact in (
        payload,
        payload.with_name(payload.name.replace("-bin-", "-bin-dwarf-", 1)),
        linux_config,
        manifest,
    ):
        try:
            artifact.unlink()
            print(f"  - removed stale generated artifact: {rel(artifact)}")
        except FileNotFoundError:
            pass
PY

cd "$firemarshal"
./marshal --workdir example-workloads -v -d build "$workload"

python3 - <<'PY'
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

repo = Path(os.environ["ELIZA_REPO_DIR"]).resolve()
payload = Path(os.environ["ELIZA_FIREMARSHAL_PAYLOAD"]).resolve()
manifest = Path(os.environ["ELIZA_FIREMARSHAL_FRESHNESS_MANIFEST"]).resolve()
linux_config = Path(os.environ["ELIZA_FIREMARSHAL_LINUX_CONFIG"]).resolve()
workload = Path(os.environ["ELIZA_FIREMARSHAL_WORKLOAD"]).resolve()
workload_dir = Path(os.environ["ELIZA_FIREMARSHAL_WORKLOAD_DIR"]).resolve()
builder = Path(os.environ["ELIZA_FIREMARSHAL_BUILDER"]).resolve()
wlutil_build = Path(os.environ["ELIZA_FIREMARSHAL_WLUTIL_BUILD"]).resolve()

inputs = [
    builder,
    wlutil_build,
    workload,
    workload_dir / "eliza-e1-linux-smoke-br-trim",
    workload_dir / "eliza-e1-linux-smoke-kfrag",
    workload_dir / "eliza-e1-linux-smoke.sh",
    workload_dir / "build-hwprobe.sh",
    workload_dir / "eliza-e1-linux-smoke-overlay/etc/init.d/S00eliza-e1-linux-smoke",
    workload_dir / "opensbi-eliza_defconfig",
    workload_dir / "eliza-riscv-hwprobe.c",
    workload_dir / "eliza-riscv-hwprobe",
    workload_dir / "e1-npu-ml-smoke",
    repo / "sw/linux/drivers/e1/Kconfig",
    repo / "sw/linux/drivers/e1/Makefile",
    repo / "sw/linux/drivers/e1/e1-dma.c",
    repo / "sw/linux/drivers/e1/e1-npu.c",
    repo / "sw/linux/drivers/e1/e1-npu-uapi.h",
    repo / "sw/linux/drivers/e1/e1_platform_contract.h",
]
optional_inputs = [
    workload_dir / "eliza-skip-unaligned-probe.patch",
    workload_dir / "opensbi-eliza-platform-fast-final.patch",
]
inputs.extend(path for path in optional_inputs if path.exists())


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


missing = [rel(path) for path in [payload, linux_config, *inputs] if not path.is_file()]
if missing:
    raise SystemExit(
        "cannot write FireMarshal payload freshness manifest; missing: "
        + ", ".join(missing)
    )

kfrag = workload_dir / "eliza-e1-linux-smoke-kfrag"
linux_config_lines = set(linux_config.read_text(encoding="utf-8").splitlines())
kfrag_lines = [
    line
    for line in kfrag.read_text(encoding="utf-8").splitlines()
    if line and not line.startswith("#")
]
missing_kfrag_lines = [line for line in kfrag_lines if line not in linux_config_lines]
if missing_kfrag_lines:
    print("STATUS: BLOCKED firemarshal.eliza_e1_linux_smoke_payload_freshness")
    print(
        "  - built linux_config is missing current "
        f"{rel(kfrag)} option(s): {', '.join(missing_kfrag_lines[:5])}"
        + (
            ""
            if len(missing_kfrag_lines) <= 5
            else f", +{len(missing_kfrag_lines) - 5} more"
        )
    )
    print("  - rerun this script after clearing the stale FireMarshal payload/config")
    raise SystemExit(2)

payload_mtime = payload.stat().st_mtime
newer_inputs = [
    rel(path)
    for path in inputs
    if path.stat().st_mtime > payload_mtime
]
if newer_inputs:
    print("STATUS: BLOCKED firemarshal.eliza_e1_linux_smoke_payload_freshness")
    print(
        "  - payload still predates current input(s): "
        + ", ".join(newer_inputs[:6])
        + ("" if len(newer_inputs) <= 6 else f", +{len(newer_inputs) - 6} more")
    )
    print("  - FireMarshal did not rebuild the nodisk payload; clear the stale artifact and rerun")
    raise SystemExit(2)

doc = {
    "schema": "eliza.firemarshal_linux_smoke_payload_freshness.v1",
    "generated_utc": datetime.now(timezone.utc).isoformat(),
    "claim_boundary": (
        "content-addressed build manifest for the FireMarshal eliza-e1-linux-smoke "
        "payload inputs; not generated-AP boot evidence"
    ),
    "producer": "scripts/build_firemarshal_eliza_linux_smoke_payload.sh",
    "payload": {
        "path": rel(payload),
        "sha256": sha256(payload),
        "bytes": payload.stat().st_size,
    },
    "inputs": {
        rel(path): {
            "sha256": sha256(path),
            "bytes": path.stat().st_size,
        }
        for path in inputs
    },
}
manifest.parent.mkdir(parents=True, exist_ok=True)
manifest.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(f"STATUS: PASS firemarshal.eliza_e1_linux_smoke_payload_freshness {rel(manifest)}")
PY
