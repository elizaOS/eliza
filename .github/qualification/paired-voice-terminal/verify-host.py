"""Same-run host metadata/custody capability. No source/native code or tests."""
import json,os,pathlib,shutil,stat,subprocess,sys
assert sys.platform=="linux" and os.uname().machine=="x86_64"
assert (3,12)<=sys.version_info[:2]<(3,16) and hasattr(os,"waitid") and hasattr(os,"WNOWAIT")
assert pathlib.Path("/proc/self/stat").is_file()
assert os.environ["ImageOS"]=="ubuntu24" and os.environ["ImageVersion"]=="20261101.360.1"
assert not any(os.environ.get(name)for name in ["DOCKER_HOST","DOCKER_CONTEXT","DOCKER_TLS_VERIFY","DOCKER_CERT_PATH"])
assert stat.S_ISSOCK(pathlib.Path("/var/run/docker.sock").stat().st_mode)
def docker(*args):return subprocess.check_output(["docker",*args],text=True,timeout=10).strip()
endpoint=json.loads(docker("context","inspect","default","--format","{{json .Endpoints.docker.Host}}"));assert endpoint=="unix:///var/run/docker.sock"
value=json.loads(docker("info","--format",'{"server":{{json .ServerVersion}},"os":{{json .OSType}},"architecture":{{json .Architecture}},"driver":{{json .Driver}}}'))
policy=json.loads((pathlib.Path(__file__).parent/"TOOLCHAIN.json").read_text());assert value["server"]==policy["expectedDockerServerVersion"] and value["os"]=="linux" and value["architecture"]=="x86_64"
assert shutil.disk_usage(os.environ["RUNNER_TEMP"]).free>=17179869184
print(json.dumps({"accepted":True,"ImageOS":os.environ["ImageOS"],"ImageVersion":os.environ["ImageVersion"],"docker":value,"endpoint":endpoint,"WNOWAIT":True,"sourceTestsExecuted":False}))
