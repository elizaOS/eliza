#!/usr/bin/env python3
import shutil
import subprocess
import sys


def run(cmd: list[str]) -> tuple[int, str]:
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)
        return 0, out.strip()
    except subprocess.CalledProcessError as exc:
        return exc.returncode, exc.output.strip()
    except FileNotFoundError as exc:
        return 127, str(exc)


def main() -> int:
    host = shutil.which("kicad-cli")
    if host:
        code, out = run(["kicad-cli", "version"])
        print(f"host kicad-cli: {out if code == 0 else 'FAILED'}")
        return code

    docker = shutil.which("docker")
    if not docker:
        print("FAIL: neither host kicad-cli nor docker is available", file=sys.stderr)
        return 1

    code, _ = run(["docker", "image", "inspect", "eliza-chip-kicad-tools:local"])
    if code != 0:
        print("FAIL: KiCad Docker image missing. Run `make kicad-setup`.", file=sys.stderr)
        return 1

    checks = [
        ["scripts/kicad_docker.sh", "kicad-cli", "version"],
        ["scripts/kicad_docker.sh", "kibot", "--version"],
        ["scripts/kicad_docker.sh", "pcbdraw", "--version"],
        [
            "scripts/kicad_docker.sh",
            "python3",
            "-c",
            "import PIL, yaml, wx; print('python deps ok')",
        ],
    ]
    for cmd in checks:
        code, out = run(cmd)
        if code != 0:
            print(f"FAIL: {' '.join(cmd)}\n{out}", file=sys.stderr)
            return code
        print(out)
    print("KiCad toolchain ok via Docker image eliza-chip-kicad-tools:local")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
