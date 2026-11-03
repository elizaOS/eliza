"""Complete bounded dependency proof; no package code is imported or executed.

Cost per pass: one no-follow scan per directory, one entry stat per child,
FD-open/stat/hash/stability checks per regular file, strict realpath checks only
for declared roots and symlinks. Proof rows are unchanged. An at-most-65,536
entry in-pass inode cache may avoid rereading proven identical physical files;
it never merges separate files by content or carries state into another pass.
"""
import hashlib
import itertools
import json
import os
import pathlib
import stat
import sys
import time

P = pathlib.Path(__file__).resolve().parent
LIMIT_BYTES = 134217728
INTERNAL_SECONDS = 85
HASH_CACHE_ENTRIES = 65536
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


def identity(value):
    return (value.st_dev, value.st_ino, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns)


class Census:
    """One scan, anchored at an owned source directory FD; all FDs close on exit."""

    def __init__(self, source, roots, started):
        self.source = pathlib.Path(source).resolve(strict=True)
        self.roots = sorted(roots)
        assert len(self.roots) == len(set(self.roots)) == 135
        self.started = started
        self.metrics = {
            "roots": 0, "directories": 0, "entryStats": 0, "fdStats": 0,
            "pathStats": 0, "strictResolves": 0, "readlinks": 0,
            "regularFiles": 0, "symlinks": 0, "hashReads": 0,
            "hashBytes": 0, "physicalHashes": 0, "hashReuses": 0,
            "cachePeakEntries": 0, "proofRows": 0, "proofBytes": 0,
            "inventoryReadBytes": 0,
        }

    def check(self):
        assert time.monotonic() - self.started < INTERNAL_SECONDS, "Dependency census wall bound"

    def fd_stat(self, fd):
        self.metrics["fdStats"] += 1
        return os.fstat(fd)

    def path_stat(self, name, fd):
        self.metrics["pathStats"] += 1
        return os.stat(name, dir_fd=fd, follow_symlinks=False)

    def resolve(self, path):
        self.metrics["strictResolves"] += 1
        target = path.resolve(strict=True)
        assert target.is_relative_to(self.source), "External dependency symlink or root"
        return target

    def hash_fd(self, fd):
        digest = hashlib.sha256()
        while True:
            self.check()
            data = os.read(fd, 65536)
            self.metrics["hashReads"] += 1
            if not data:
                break
            self.metrics["hashBytes"] += len(data)
            digest.update(data)
        return digest.hexdigest()

    def rows(self):
        # This cache is local to this generator/pass, never receipt-seeded.
        hashes = {}
        source_fd = os.open(self.source, DIR_FLAGS)
        try:
            source_before = identity(self.fd_stat(source_fd))
            for relative in self.roots:
                self.check()
                parts = pathlib.PurePosixPath(relative).parts
                assert parts and not pathlib.PurePosixPath(relative).is_absolute() and ".." not in parts
                root = self.source / relative
                self.metrics["pathStats"] += 1
                try:
                    entry_before = root.lstat()
                except FileNotFoundError:
                    self.metrics["roots"] += 1
                    yield {"path": relative, "kind": "root", "state": "absent"}
                    # Absence cannot silently become a skipped newly created root.
                    self.metrics["pathStats"] += 1
                    try:
                        root.lstat()
                    except FileNotFoundError:
                        continue
                    raise AssertionError("Dependency root appeared during scan")
                if stat.S_ISLNK(entry_before.st_mode):
                    self.metrics["readlinks"] += 1
                    state = {"path": relative, "kind": "root", "state": "symlink", "target": os.readlink(root)}
                else:
                    assert stat.S_ISDIR(entry_before.st_mode), "Dependency root is not a directory"
                    state = {"path": relative, "kind": "root", "state": "directory"}
                canonical = self.resolve(root)
                self.metrics["pathStats"] += 1
                target_before = canonical.stat(follow_symlinks=False)
                assert stat.S_ISDIR(target_before.st_mode), "Dependency root target changed"
                # Open each canonical component from the source FD, with no
                # symlink following. A raced ancestor cannot route content reads
                # outside the admitted source directory.
                root_fd = os.dup(source_fd)
                try:
                    for component in canonical.relative_to(self.source).parts:
                        next_fd = os.open(component, DIR_FLAGS, dir_fd=root_fd)
                        os.close(root_fd)
                        root_fd = next_fd
                    assert identity(self.fd_stat(root_fd)) == identity(target_before), "Dependency root target changed"
                    self.metrics["roots"] += 1
                    yield state
                    yield from self.walk(relative, root_fd, hashes)
                    self.metrics["pathStats"] += 1
                    assert identity(root.lstat()) == identity(entry_before), "Dependency root entry changed"
                    assert self.resolve(root) == canonical, "Dependency root target changed"
                    self.metrics["pathStats"] += 1
                    assert identity(canonical.stat(follow_symlinks=False)) == identity(target_before), "Dependency root target changed"
                finally:
                    os.close(root_fd)
            assert identity(self.fd_stat(source_fd)) == source_before, "Source directory changed during census"
        finally:
            os.close(source_fd)

    def walk(self, relative, directory_fd, hashes):
        self.check()
        before = identity(self.fd_stat(directory_fd))
        self.metrics["directories"] += 1
        leaves, directories = [], []
        # DirEntry metadata is captured while scandir's FD is live. Errors are
        # propagated; no os.walk default error suppression or symlink recursion.
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                self.check()
                self.metrics["entryStats"] += 1
                metadata = entry.stat(follow_symlinks=False)
                item = (entry.name, metadata)
                if stat.S_ISDIR(metadata.st_mode):
                    directories.append(item)
                else:
                    leaves.append(item)
        for name, expected in sorted(leaves):
            self.check()
            path = relative + "/" + name
            if stat.S_ISLNK(expected.st_mode):
                self.metrics["readlinks"] += 1
                target = os.readlink(name, dir_fd=directory_fd)
                self.resolve(self.source / path)
                assert identity(self.path_stat(name, directory_fd)) == identity(expected), "Dependency symlink changed"
                self.metrics["symlinks"] += 1
                yield {"path": path, "kind": "symlink", "target": target}
                continue
            assert stat.S_ISREG(expected.st_mode), "Dependency entry is not a regular file"
            fd = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
            try:
                opened = self.fd_stat(fd)
                key = identity(opened)
                assert stat.S_ISREG(opened.st_mode) and key == identity(expected), "Dependency file changed before open"
                if key in hashes:
                    digest = hashes[key]
                    self.metrics["hashReuses"] += 1
                else:
                    digest = self.hash_fd(fd)
                    self.metrics["physicalHashes"] += 1
                assert identity(self.fd_stat(fd)) == key, "Dependency file changed during hash"
                assert identity(self.path_stat(name, directory_fd)) == key, "Dependency file path changed during hash"
                if key not in hashes and len(hashes) < HASH_CACHE_ENTRIES:
                    hashes[key] = digest
                    self.metrics["cachePeakEntries"] = max(self.metrics["cachePeakEntries"], len(hashes))
            finally:
                os.close(fd)
            self.metrics["regularFiles"] += 1
            yield {"path": path, "kind": "file", "bytes": opened.st_size, "sha256": digest}
        for name, expected in sorted(directories):
            fd = os.open(name, DIR_FLAGS, dir_fd=directory_fd)
            try:
                assert identity(self.fd_stat(fd)) == identity(expected), "Dependency directory changed before open"
                yield from self.walk(relative + "/" + name, fd, hashes)
                assert identity(self.path_stat(name, directory_fd)) == identity(expected), "Dependency directory path changed"
            finally:
                os.close(fd)
        assert identity(self.fd_stat(directory_fd)) == before, "Dependency directory changed during census"


def main(argv):
    started = time.monotonic()
    mode, src, out, commit, tree, lock = argv
    assert mode in ("capture", "verify")
    source = pathlib.Path(src).resolve(strict=True)
    output = pathlib.Path(out).resolve(strict=True)
    roots = json.loads((P / "WORKSPACE-DEPENDENCY-ROOTS.json").read_text())
    census = Census(source, roots, started)
    inventory = output / "dependency-files.jsonl"
    counts = {"root": 0, "file": 0, "symlink": 0}
    total, inventory_hash = 0, hashlib.sha256()
    scanner = census.rows()
    try:
        if mode == "capture":
            with inventory.open("xb") as stream:
                for value in scanner:
                    data = (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()
                    total += len(data)
                    assert total <= LIMIT_BYTES, "Dependency receipt byte bound"
                    assert stream.write(data) == len(data)
                    inventory_hash.update(data)
                    counts[value["kind"]] += 1
        else:
            receipt = json.loads((output / "DEPENDENCY-INVENTORY.json").read_text())
            assert receipt["sourceRoot"] == str(source) and receipt["sourceCommit"] == commit and receipt["sourceTree"] == tree and receipt["bunLockSHA256"] == lock
            with inventory.open("rb") as stream:
                for old, value in itertools.zip_longest(stream, scanner):
                    census.check()
                    assert old is not None and value is not None, "Physical dependency/root set changed"
                    data = (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()
                    assert old == data, "Physical dependency/root set or bytes changed"
                    total += len(old)
                    assert total <= LIMIT_BYTES, "Dependency receipt byte bound"
                    inventory_hash.update(old)
                    census.metrics["inventoryReadBytes"] += len(old)
                    counts[value["kind"]] += 1
            assert inventory_hash.hexdigest() == receipt["inventorySHA256"], "Dependency inventory hash changed"
            assert counts["root"] == receipt["rootStates"] == 135 and counts["file"] == receipt["files"] and counts["symlink"] == receipt["symlinks"] and sum(counts.values()) == receipt["entries"]
        census.check()
        assert counts["root"] == 135 and counts["file"] > 0
        census.metrics["proofRows"] = sum(counts.values())
        census.metrics["proofBytes"] = total
        metrics = {**census.metrics, "seconds": time.monotonic() - started,
                   "scope": "Code-site operation counts, not a syscall profiler; no full hosted speedup claim"}
        if mode == "capture":
            receipt = {"sourceRoot": str(source), "sourceCommit": commit, "sourceTree": tree,
                       "bunLockSHA256": lock, "platform": "linux-x64", "files": counts["file"],
                       "rootStates": counts["root"], "symlinks": counts["symlink"], "entries": sum(counts.values()),
                       "inventorySHA256": inventory_hash.hexdigest(), "inventoryBytes": total,
                       "ignoreScripts": True, "nativeHooksExecuted": False,
                       "scope": "Actual canonical manifest/frozen-lock installed dependency bytes and all declared root states; not normal native hook/lifecycle qualification"}
            with (output / "DEPENDENCY-INVENTORY.json").open("x") as stream:
                json.dump(receipt, stream, indent=2)
                stream.write("\n")
        # The unchanged operator verifies twice in separate processes. Emit
        # every pass's counters into its already unique phase log; only capture
        # has a single stable extra metrics receipt.
        if mode == "capture":
            with (output / "CENSUS-capture-METRICS.json").open("x") as stream:
                json.dump(metrics, stream, indent=2)
                stream.write("\n")
        print(json.dumps({"counts": counts, "inventorySHA256": inventory_hash.hexdigest(), "metrics": metrics}))
    except BaseException:
        failed = {"state": "INCOMPLETE", "errorClass": sys.exc_info()[0].__name__,
                  "metrics": {**census.metrics, "seconds": time.monotonic() - started},
                  "completeDependencyReceipt": False}
        try:
            with (output / ("CENSUS-" + mode + "-INCOMPLETE-" + str(os.getpid()) + ".json")).open("x") as stream:
                json.dump(failed, stream, indent=2)
                stream.write("\n")
        except OSError:
            print("Census failure metrics could not be written", file=sys.stderr)
        print(json.dumps(failed), flush=True)
        raise
    finally:
        scanner.close()


if __name__ == "__main__":
    main(sys.argv[1:])
