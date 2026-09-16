#!/usr/bin/python3
"""Build an immutable native authority before any scenario payload is admitted.

The trusted setup process supplies reviewed checkout source. Installation never
changes kernel or security policy and publishes its unique root only after all
source, tool, BTF and output identities have been recorded and synced.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile


HELPERS = (
    "stability-sandbox-identity.py", "stability-sandbox-exec.py",
    "stability-sandbox-owner.py", "stability-native-attestation.py",
    "stability-linux-sandbox.sh",
)
NATIVE = ("ledger.h", "ledger.bpf.c", "retirement.h", "retirement.bpf.c", "collector.c")
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read_source(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 4 * 1024 * 1024:
            raise RuntimeError("installer source is not a bounded regular file")
        chunks = []
        remaining = before.st_size
        while remaining:
            value = os.read(fd, min(remaining, 65536))
            if not value:
                raise RuntimeError("installer source changed during read")
            chunks.append(value)
            remaining -= len(value)
        after = os.fstat(fd)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if identity(before) != identity(after) or os.read(fd, 1):
            raise RuntimeError("installer source changed during read")
        return b"".join(chunks)
    finally:
        os.close(fd)


def immutable_path(path, directory=False):
    path = pathlib.Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise RuntimeError("installer authority path is not canonical")
    for current in (path, *path.parents):
        info = current.lstat()
        expected_directory = directory or current != path
        if info.st_uid != 0 or info.st_mode & 0o022 or not (
            stat.S_ISDIR(info.st_mode) if expected_directory else stat.S_ISREG(info.st_mode)
        ):
            raise RuntimeError("installer authority path is writable or not root owned")
    return path


def run(args, timeout=60):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=ENV, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"native installer command failed: {args[0]} status={result.returncode}: " + result.stderr.decode("utf8", errors="replace"))
    return result.stdout


def installed_package(query, name):
    raw = run([str(query), "--admindir=/var/lib/dpkg", "--show",
               "--showformat=${Status}\t${binary:Package}\t${Version}\t${Architecture}\t${Depends}\n", name])
    rows = raw.decode("utf8").splitlines()
    fields = rows[0].split("\t") if len(rows) == 1 else []
    if len(fields) != 5 or fields[0] != "install ok installed" or fields[1] not in (name, name + ":amd64") or fields[3] != "amd64" or not re.fullmatch(r"[0-9][A-Za-z0-9.+:~\-]*", fields[2]):
        raise RuntimeError(f"native installer needs unambiguous installed amd64 package metadata: {name}")
    return {"package": name, "version": fields[2], "depends": fields[4]}


def tool_dependency(package, pattern):
    candidates = [part.strip() for part in package["depends"].split(",")
                  if "linux-tools-" in part]
    if len(candidates) != 1:
        raise RuntimeError(f"native installer package has missing or ambiguous tool dependency: {package['package']}")
    match = re.fullmatch("(" + pattern + r")(?:(?: )+\(= ([0-9][A-Za-z0-9.+:~\-]*)\))?", candidates[0])
    if match is None:
        raise RuntimeError(f"native installer package has unsupported tool dependency: {package['package']}")
    return match.group(1), match.group(2)


def packaged_bpftool():
    # Query only the installed dependency chain, never wrapper text or a newest-file glob.
    query = immutable_path("/usr/bin/dpkg-query")
    immutable_path("/var/lib/dpkg", directory=True)
    immutable_path("/var/lib/dpkg/status")
    info = immutable_path("/var/lib/dpkg/info", directory=True)
    packages = [installed_package(query, "linux-tools-generic")]
    name, required_version = tool_dependency(packages[-1], r"linux-tools-[0-9]+\.[0-9]+\.[0-9]+-[0-9]+-generic")
    generic_name = name
    for pattern in (re.escape(generic_name.removesuffix("-generic")), None):
        package = installed_package(query, name)
        if required_version is not None and package["version"] != required_version:
            raise RuntimeError("native installer installed tool dependency version does not match")
        packages.append(package)
        if pattern is not None:
            name, required_version = tool_dependency(package, pattern)
    lists = [path for path in (info / (name + ".list"), info / (name + ":amd64.list"))
             if path.exists() or path.is_symlink()]
    if len(lists) != 1:
        raise RuntimeError("native installer needs one installed tool package file inventory")
    immutable_path(lists[0])
    paths = run([str(query), "--admindir=/var/lib/dpkg", "--listfiles", name]).decode("utf8").splitlines()
    candidates = [path for path in paths if pathlib.PurePosixPath(path).name == "bpftool"]
    expected = "/usr/lib/" + name + "/bpftool"
    if candidates != [expected]:
        raise RuntimeError("native installer package does not own one expected bpftool executable")
    executable = immutable_path(expected)
    if not executable.read_bytes().startswith(b"\x7fELF"):
        raise RuntimeError("native installer packaged bpftool is not an ELF executable")
    return executable, {"package": name, "packageVersion": packages[-1]["version"],
                        "packageChain": [{"package": item["package"], "version": item["version"]} for item in packages]}


def resolve_bpftool():
    kernel_tool = pathlib.Path("/usr/lib/linux-tools") / os.uname().release / "bpftool"
    if kernel_tool.exists():
        executable = immutable_path(kernel_tool.resolve(strict=True))
        if executable.read_bytes().startswith(b"\x7fELF"):
            return executable, {}
    # Some Ubuntu Azure tool packages omit bpftool; linux-tools-common is only a wrapper.
    return packaged_bpftool()


def write(path, value, mode=0o400):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, mode)
    try:
        offset = 0
        while offset < len(value):
            count = os.write(fd, value[offset:])
            if count <= 0:
                raise RuntimeError("native installer output write failed")
            offset += count
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install(source_root):
    if sys.platform != "linux" or os.geteuid() != 0 or os.uname().machine != "x86_64":
        raise RuntimeError("native installer requires root on supported x86_64 Linux")
    if not pathlib.Path("/run/systemd/system").is_dir() or not pathlib.Path("/sys/fs/cgroup/cgroup.controllers").is_file() or (os.cpu_count() or 0) < 2:
        raise RuntimeError("native installer requires systemd, cgroup v2 and two CPUs")
    parent = immutable_path("/opt", directory=True)
    # The caller may name its checkout through /tmp; nested source aliases are not admitted.
    source_root = pathlib.Path(source_root).resolve(strict=True)
    native_source = source_root / "native-ledger"
    if not stat.S_ISDIR(native_source.lstat().st_mode) or native_source.resolve(strict=True) != native_source:
        raise RuntimeError("native installer source directory is a symlink or not a directory")
    sources = {name: read_source(source_root / name) for name in HELPERS}
    sources.update({"native-ledger/" + name: read_source(source_root / "native-ledger" / name) for name in NATIVE})
    btf = pathlib.Path("/sys/kernel/btf/vmlinux").read_bytes()
    tools = {}
    for name, version in (("clang-18", "--version"), ("bpftool", "version")):
        provenance = {}
        if name == "bpftool":
            executable, provenance = resolve_bpftool()
        else:
            found = shutil.which(name, path=ENV["PATH"])
            if found is None:
                raise RuntimeError(f"native installer prerequisite missing: {name}")
            executable = immutable_path(pathlib.Path(found).resolve(strict=True))
        executable_bytes = executable.read_bytes()
        if not executable_bytes.startswith(b"\x7fELF"):
            raise RuntimeError(f"native installer needs the actual packaged ELF tool, not a wrapper: {name}")
        tools[name] = {"path": str(executable), "sha256": digest(executable_bytes),
                       "version": run([str(executable), version]).decode("utf8"), **provenance}
    root = pathlib.Path(tempfile.mkdtemp(prefix="eliza-native-", dir=parent))
    root.chmod(0o700)
    try:
        bundle = root / "native-ledger"
        bundle.mkdir(mode=0o700)
        for name, value in sources.items():
            write(root / name, value, 0o500 if name.endswith(".sh") else 0o400)
        header = run([tools["bpftool"]["path"], "btf", "dump", "file", "/sys/kernel/btf/vmlinux", "format", "c"])
        write(bundle / "vmlinux.h", header)
        clang = tools["clang-18"]["path"]
        for name in ("ledger", "retirement"):
            run([clang, "-g", "-O2", "-target", "bpf", "-D__TARGET_ARCH_x86",
                 "-I/usr/include/x86_64-linux-gnu", "-c", str(bundle / (name + ".bpf.c")),
                 "-o", str(bundle / (name + ".bpf.o"))])
        run([clang, "-Wall", "-Wextra", "-Werror", "-O2", "-I" + str(bundle),
             str(bundle / "collector.c"), "-lbpf", "-lelf", "-lz", "-o", str(bundle / "collector")])
        if digest(pathlib.Path("/sys/kernel/btf/vmlinux").read_bytes()) != digest(btf):
            raise RuntimeError("native installer kernel BTF changed during build")
        artifacts = {}
        for name in ("collector", "ledger.bpf.o", "retirement.bpf.o"):
            target = bundle / name
            target.chmod(0o500 if name == "collector" else 0o400)
            artifacts[name] = digest(target.read_bytes())
            fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        manifest = {"kernel": os.uname().release, "btfSha256": digest(btf),
                    "sources": {name: digest(sources["native-ledger/" + name]) for name in NATIVE},
                    "artifacts": artifacts, "tools": tools, "headerSha256": digest(header)}
        write(bundle / "build.json", json.dumps(manifest, sort_keys=True).encode())
        receipt = {"installedRoot": str(root), "build": manifest,
                   "installerSha256": digest(read_source(pathlib.Path(__file__))),
                   "sourceSha256": {name: digest(value) for name, value in sources.items()},
                   "qualification": "Built source-bound authority; actual hook admission and authenticated scenario proof remain required."}
        write(root / "installation.json", json.dumps(receipt, sort_keys=True).encode())
        sync_directory(bundle)
        sync_directory(root)
        sync_directory(parent)
        return receipt
    except BaseException as primary:
        # error-policy:J2 Preserve build failure; report any failure removing only this owned installation.
        try:
            shutil.rmtree(root)
            sync_directory(parent)
        except BaseException as cleanup:
            raise BaseExceptionGroup(f"native installer failed and retained owned directory: {root}", [primary, cleanup])
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.source_root), sort_keys=True), flush=True)
