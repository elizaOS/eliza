#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "$repo_dir/build/reports"

if [ -d "$repo_dir/tools/bin" ]; then
    PATH="$repo_dir/tools/bin:$PATH"
fi
if [ -d "$repo_dir/.venv/bin" ]; then
    PATH="$repo_dir/.venv/bin:$PATH"
fi
if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi
if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/KiCad/KiCad.app/Contents/MacOS" ]; then
    PATH="/Applications/KiCad/KiCad.app/Contents/MacOS:$PATH"
fi

hash_file() {
    file="$1"
    if [ -f "$file" ] && command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    elif [ -f "$file" ] && command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    else
        printf "UNAVAILABLE"
    fi
}

print_version() {
    tool="$1"
    case "$tool" in
        iverilog)
            "$tool" -V 2>&1 | head -n 1 || true
            ;;
        klayout)
            printf "SKIPPED_VERSION_PROBE\n"
            ;;
        nix)
            printf "SKIPPED_VERSION_PROBE\n"
            ;;
        *)
            "$tool" --version 2>&1 | head -n 1 || true
            ;;
    esac
}

python_bin=python3
if [ -x "$repo_dir/.venv/bin/python" ]; then
    python_bin="$repo_dir/.venv/bin/python"
fi

openlane_image="${OPENLANE_IMAGE:-ghcr.io/efabless/openlane2:2.4.0.dev1}"
openlane_image_digest="${OPENLANE_IMAGE_DIGEST:-sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5}"

{
    date -u +"timestamp_utc=%Y-%m-%dT%H:%M:%SZ"
    printf "repo_dir=%s\n" "$repo_dir"
    if [ -d "$repo_dir/.venv" ]; then
        printf "venv_path=%s\n" "$repo_dir/.venv"
    else
        printf "venv_path=MISSING\n"
    fi
    printf "python_selected=%s\n" "$python_bin"
    printf "requirements_sha256=%s\n" "$(hash_file "$repo_dir/requirements.txt")"
    printf "dockerfile_sha256=%s\n" "$(hash_file "$repo_dir/Dockerfile")"
    printf "flake_sha256=%s\n" "$(hash_file "$repo_dir/flake.nix")"
    printf "openlane_image=%s\n" "$openlane_image"
    printf "openlane_image_digest_expected=%s\n" "$openlane_image_digest"
    if command -v docker >/dev/null 2>&1; then
        if docker manifest inspect --verbose "$openlane_image" 2>/dev/null | grep "$openlane_image_digest" >/dev/null 2>&1; then
            printf "openlane_image_digest_manifest=FOUND\n"
        else
            printf "openlane_image_digest_manifest=NOT_FOUND_OR_UNAVAILABLE\n"
        fi
        if docker image inspect "$openlane_image" >/dev/null 2>&1; then
            printf "openlane_image_installed=YES\n"
        else
            printf "openlane_image_installed=NO\n"
        fi
    else
        printf "openlane_image_digest_manifest=DOCKER_MISSING\n"
        printf "openlane_image_installed=DOCKER_MISSING\n"
    fi
    for tool in docker nix verilator yosys yosys-smtbmc sby z3 boolector openroad openlane flow.tcl nextpnr-ecp5 ecppack klayout magic netgen iverilog gtkwave python3 pip3 make cmake ninja git rsync java javac repo adb cvd launch_cvd dtc bc flex bison riscv64-unknown-elf-gcc riscv64-linux-gnu-gcc qemu-system-riscv64 renode kicad-cli fio bw_mem lat_mem_rd coremark stream_c.exe benchmark_model openocd sigrok-cli; do
        if command -v "$tool" >/dev/null 2>&1; then
            printf "%s_path=%s\n" "$tool" "$(command -v "$tool")"
            print_version "$tool" | sed "s/^/${tool}_version=/" || true
        else
            printf "%s_path=MISSING\n" "$tool"
        fi
    done
    "$python_bin" - <<'PY'
import importlib.metadata

packages = [
    ("cocotb", "cocotb"),
    ("pytest", "pytest"),
    ("numpy", "numpy"),
    ("PyYAML", "yaml"),
]
for dist, module in packages:
    try:
        __import__(module)
        version = importlib.metadata.version(dist)
    except Exception:
        version = "MISSING"
    print(f"python_package_{dist}={version}")
PY
    if command -v git >/dev/null 2>&1 && git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        printf "git_head=%s\n" "$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)"
        printf "git_dirty=%s\n" "$(git -C "$repo_dir" status --short | wc -l | tr -d ' ')"
    fi
} > "$repo_dir/build/reports/tool_versions.txt"

echo "Tool versions: build/reports/tool_versions.txt"
