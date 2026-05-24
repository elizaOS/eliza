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

mkdir -p "$tool_out" "$build_dir"

path_value="$wrapper_bin:$repo_dir/build/tool-wrappers:$repo_dir/tools/bin:$deb_tool_bin:$PATH"
if [ -d "$deb_tool_lib" ]; then
	LD_LIBRARY_PATH="$deb_tool_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
	export LD_LIBRARY_PATH
fi
PATH="$path_value"
export PATH

cc="${RISCV64_LINUX_CC:-riscv64-unknown-linux-gnu-gcc}"

if ! command -v "$cc" >/dev/null 2>&1; then
	printf 'STATUS: BLOCKED firemarshal.eliza_e1_ap_benchmarks_payload\n'
	printf '  - missing RV64 Linux compiler: %s\n' "$cc"
	exit 2
fi

printf 'Building AP benchmark target tools with %s\n' "$cc"

if [ -x "$repo_dir/external/coremark/coremark.exe" ]; then
	cp "$repo_dir/external/coremark/coremark.exe" "$tool_out/coremark"
else
	make -C "$repo_dir/external/coremark" PORT_DIR=linux CC="$cc" XCFLAGS="-static" compile
	cp "$repo_dir/external/coremark/coremark.exe" "$tool_out/coremark"
fi

if [ -x "$repo_dir/benchmarks/memory/stream/stream" ]; then
	cp "$repo_dir/benchmarks/memory/stream/stream" "$tool_out/stream_c.exe"
else
	"$cc" -O2 -static -o "$tool_out/stream_c.exe" "$repo_dir/benchmarks/memory/stream/stream.c"
fi

"$cc" -O2 -static -o "$tool_out/lat_mem_rd" "$workload_dir/lat_mem_rd.c"

fio_src="$repo_dir/external/fio-src"
fio_build="$build_dir/fio-src"
if [ ! -f "$fio_src/configure" ]; then
	printf 'STATUS: BLOCKED firemarshal.eliza_e1_ap_benchmarks_payload\n'
	printf '  - missing fio source tree: %s\n' "$fio_src"
	exit 2
fi

rm -rf "$fio_build"
cp -a "$fio_src" "$fio_build"
find "$fio_build" -name '*.o' -o -name '*.d' -o -name 'fio' | xargs -r rm -f
(
	cd "$fio_build"
	./configure --cc="$cc" --cpu=riscv64 --build-static --disable-native --disable-lex --disable-numa --disable-rdma --disable-rados --disable-rbd --disable-http --disable-gfapi --disable-libnfs --disable-pmem --disable-shm --disable-xnvme --disable-isal --disable-isal64 --disable-libblkio --disable-libzbc --disable-tcmalloc --disable-dfs --disable-tls
	make -j"${ELIZA_AP_BENCHMARKS_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 2)}" fio
)
cp "$fio_build/fio" "$tool_out/fio"
chmod 0755 "$tool_out/coremark" "$tool_out/stream_c.exe" "$tool_out/lat_mem_rd" "$tool_out/fio"

for tool in coremark stream_c.exe lat_mem_rd fio; do
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
