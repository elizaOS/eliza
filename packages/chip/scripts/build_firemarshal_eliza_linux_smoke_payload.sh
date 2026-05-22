#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
firemarshal="$repo_dir/external/chipyard/software/firemarshal"
workload="$repo_dir/sw/firemarshal/eliza-e1-linux-smoke.json"
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

cd "$firemarshal"
./marshal --workdir example-workloads -v -d build "$workload"
