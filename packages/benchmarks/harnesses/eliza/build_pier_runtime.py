"""Build a versioned Linux Eliza bundle for the isolated Pier agent adapter."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import subprocess
import tarfile
import uuid
from pathlib import Path


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def build(repo: Path, revision: str, output: Path) -> dict:
    tree = git(repo, "rev-parse", revision + "^{tree}")
    root = json.loads(git(repo, "show", tree + ":package.json"))
    paths = git(repo, "ls-tree", "-r", "--name-only", tree).splitlines()
    packages = {}
    for path in paths:
        directory = Path(path).parent
        if not path.endswith("/package.json") or not any(
            len(directory.parts) == len(Path(pattern).parts) and directory.match(pattern)
            for pattern in root["workspaces"]
        ):
            continue
        manifest = json.loads(git(repo, "show", tree + ":" + path))
        if manifest.get("name"):
            packages[manifest["name"]] = (str(directory), manifest)
    pending = ["@elizaos/agent"]
    selected = set()
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        if name not in packages:
            raise ValueError(f"Missing workspace dependency: {name}")
        selected.add(name)
        _, manifest = packages[name]
        for section in ("dependencies", "optionalDependencies", "peerDependencies"):
            for dependency, version in manifest.get(section, {}).items():
                optional_peer = manifest.get("peerDependenciesMeta", {}).get(dependency, {}).get("optional")
                if section == "peerDependencies" and optional_peer and not version.startswith("workspace:"):
                    continue
                if version.startswith("workspace:"):
                    pending.append(dependency)
    directories = sorted(packages[name][0] for name in selected)
    output.mkdir(parents=True, exist_ok=False)
    context = output / "context"
    context.mkdir()
    process = subprocess.Popen(["git", "-C", str(repo), "archive", tree, *directories], stdout=subprocess.PIPE)
    assert process.stdout is not None
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            archive.extractall(context, filter="data")
        if process.wait():
            raise RuntimeError("Could not export the selected runtime source")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
    manifest = {"name": "eliza-deepswe-runtime", "private": True, "type": "module", "workspaces": directories}
    for key in ("overrides", "resolutions", "trustedDependencies"):
        if key in root:
            manifest[key] = root[key]
    (context / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for directory in directories:
        path = context / directory / "package.json"
        manifest = json.loads(path.read_text())
        manifest.pop("devDependencies", None)
        for name, meta in manifest.get("peerDependenciesMeta", {}).items():
            if meta.get("optional"):
                manifest.get("peerDependencies", {}).pop(name, None)
        path.write_text(json.dumps(manifest, indent=2) + "\n")
    (context / "Dockerfile").write_text(
        "FROM oven/bun:1.4.2 AS runtime\nWORKDIR /opt/eliza\nCOPY . .\n"
        "RUN bun install --production --ignore-scripts\n"
        'ENTRYPOINT ["bun", "--no-install", "--conditions=eliza-source", "/opt/eliza/packages/agent/src/bin.ts"]\n'
    )
    image = "eliza-pier-runtime:" + tree[:12]
    with (output / "build.log").open("w") as log:
        subprocess.run(["docker", "build", "--platform", "linux/amd64", "--tag", image, str(context)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    bundle = output / "runtime.tar.gz"
    command = "mkdir -p /opt/eliza/bin && cp /usr/local/bin/bun /opt/eliza/bin/bun && tar -C /opt/eliza -cf - ."
    container = "eliza-pier-export-" + uuid.uuid4().hex
    with (output / "export.log").open("w") as log:
        process = subprocess.Popen(["docker", "run", "--rm", "--name", container, "--platform", "linux/amd64", "--entrypoint", "sh",
                                    image, "-c", command], stdout=subprocess.PIPE, stderr=log)
        assert process.stdout is not None
        try:
            with bundle.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=1, mtime=0) as compressed:
                shutil.copyfileobj(process.stdout, compressed)
            if process.wait():
                raise RuntimeError("Could not export the Linux runtime bundle")
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
        finally:
            process.stdout.close()
            subprocess.run(["docker", "rm", "--force", container], stdout=log, stderr=log, timeout=30, check=False)
    with bundle.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    image_id = subprocess.check_output(["docker", "image", "inspect", image, "--format", "{{.Id}}"], text=True).strip()
    result = {"path": str(bundle), "sha256": digest, "source_tree": tree, "image": image_id,
              "bytes": bundle.stat().st_size, "workspaces": directories,
              "install_policy": "production dependencies; lifecycle scripts disabled; resolved lockfile inside bundle"}
    (output / "bundle.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path, required=True, help="New directory under repository-root test-results")
    args = parser.parse_args()
    print(json.dumps(build(args.repository.resolve(), args.revision, args.output.resolve()), indent=2))
