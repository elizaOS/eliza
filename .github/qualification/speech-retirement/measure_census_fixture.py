"""One old/new small-fixture measurement; no dependencies/products/network."""
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tempfile

P = pathlib.Path(__file__).resolve().parent
WRAPPER = r'''
import cProfile,json,pathlib,resource,runpy,sys,time
script,source,output,report=sys.argv[1:]
sys.argv=[script,"capture",source,output,"fixture-commit","fixture-tree","fixture-lock"]
profiler=cProfile.Profile();started=time.monotonic();profiler.enable()
runpy.run_path(script,run_name="__main__")
profiler.disable();elapsed=time.monotonic()-started
calls=[]
for value in profiler.getstats():
 code=value.code
 if isinstance(code,str):
  label=code
 else:
  label=code.co_filename+":"+str(code.co_firstlineno)+":"+code.co_name
 if any(part in label for part in ["resolve", "is_file", "is_symlink", "posix.stat", "posix.lstat", "posix.fstat", "posix.open", "posix.read", "posix.scandir"]):
  calls.append({"site":label,"calls":value.callcount,"seconds":value.totaltime})
pathlib.Path(report).write_text(json.dumps({"elapsedProfiledSeconds":elapsed,"operationSites":calls,"maxRSSRaw":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},indent=2)+"\n")
'''


def main():
    with tempfile.TemporaryDirectory(prefix="eliza-census-cost-fixture-") as name:
        base = pathlib.Path(name)
        source = base / "source"
        source.mkdir()
        folder = source / "node_modules"
        folder.mkdir()
        for index in range(12):
            folder = folder / ("depth-" + str(index))
            folder.mkdir()
        for index in range(2048):
            (folder / (f"file-{index:04}.txt")).write_bytes(("fixture-" + str(index)).encode())
        for index in range(32):
            os.link(folder / "file-0000.txt", folder / (f"hardlink-{index:03}.txt"))
        (source / "node_modules/inner-link").symlink_to("depth-0", target_is_directory=True)
        old_home = base / "old"
        old_home.mkdir()
        shutil.copy2(P / "reference/inventory_dependencies.py", old_home / "inventory_dependencies.py")
        shutil.copy2(P / "WORKSPACE-DEPENDENCY-ROOTS.json", old_home / "WORKSPACE-DEPENDENCY-ROOTS.json")
        results = {}
        outputs = {}
        for kind, script in [("old", old_home / "inventory_dependencies.py"), ("new", P / "inventory_dependencies.py")]:
            output = base / (kind + "-out")
            output.mkdir()
            report = base / (kind + "-profile.json")
            run = subprocess.run([sys.executable, "-I", "-B", "-c", WRAPPER, str(script), str(source), str(output), str(report)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={"PATH": os.environ.get("PATH", ""), "HOME": str(base)}, timeout=15)
            assert run.returncode == 0, run.stderr.decode()
            results[kind] = {**json.loads(report.read_text()), "stdout": run.stdout.decode(), "exit": run.returncode}
            outputs[kind] = (output / "dependency-files.jsonl").read_bytes()
        assert outputs["old"] == outputs["new"]
        result = {"state": "SMALL_FIXTURE_MEASUREMENT_NOT_HOSTED_PERFORMANCE_ACCEPTANCE",
                  "platform": platform.platform(), "python": platform.python_version(),
                  "maxRSSUnit": "bytes" if sys.platform == "darwin" else "KiB",
                  "fixture": {"regularFiles": 2080, "depth": 12, "hardlinks": 32, "directorySymlinks": 1, "declaredRoots": 135},
                  "proofBytes": len(outputs["new"]), "proofSHA256": hashlib.sha256(outputs["new"]).hexdigest(),
                  "oldNewProofBytesEqual": True, "runs": results,
                  "limits": "One old/new profiled pass on tiny owned files only; profiler overhead included. No extrapolated full hosted speedup or root-cause fraction. Full85s hosted remeasurement still requires review/newRootGO."}
        (P / "SMALL-FIXTURE-COST-RESULT.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"proofEqual": True, "oldSeconds": results["old"]["elapsedProfiledSeconds"],
                          "newSeconds": results["new"]["elapsedProfiledSeconds"], "result": str(P / "SMALL-FIXTURE-COST-RESULT.json")}))


if __name__ == "__main__":
    main()
