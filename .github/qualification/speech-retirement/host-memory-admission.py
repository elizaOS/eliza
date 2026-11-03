"""Read-only explicit effective host/engine/cgroup budget gate for an 8GiB task."""
from pathlib import Path
import json,os,subprocess,sys
assert os.environ.get('DOCKER_HOST')=='unix:///var/run/docker.sock'and not os.environ.get('DOCKER_CONTEXT')
for key in ['DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION']:assert not os.environ.get(key)
result=Path(sys.argv[1]);info=json.loads(subprocess.check_output(['docker','info','--format','{{json .}}'],timeout=10))
assert info['OSType']=='linux'and info['Architecture']=='x86_64'
assert info['MemoryLimit']and info['SwapLimit']and info['CgroupVersion']=='2'and info['CgroupDriver']=='systemd'
assert info['MemTotal']>=15*1024**3,'Engine below compiler host profile'
context=json.loads(subprocess.check_output(['docker','context','inspect'],timeout=10));assert len(context)==1
assert context[0]['Endpoints']['docker']['Host']=='unix:///var/run/docker.sock','Remote or unknown engine not admitted'
memory={line.split(':',1)[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()if line.startswith(('MemTotal:','MemAvailable:'))}
assert memory['MemTotal']>=15*1024**3 and memory['MemAvailable']>=10*1024**3,'Host budget insufficient'
own=Path('/proc/self/cgroup').read_text().splitlines();assert len(own)==1 and own[0].startswith('0::/')
relative=own[0][3:];assert '..'not in Path(relative).parts
mounts=Path('/proc/self/mountinfo').read_text().splitlines();cgroups=[x for x in mounts if' - cgroup2 'in x];assert len(cgroups)==1
left=cgroups[0].split(' - ',1)[0].split();assert left[3]=='/'and left[4]=='/sys/fs/cgroup','Unknown effective cgroup namespace'
root=Path('/sys/fs/cgroup');paths=set();p=root/relative.lstrip('/')
while p!=root:
 assert p.is_relative_to(root);paths.add(p);p=p.parent
paths.add(root/'system.slice')
limits=[]
for p in sorted(paths):
 f=p/'memory.max';assert f.is_file(),'Unknown effective memory ceiling: '+str(p)
 raw=f.read_text().strip();assert raw=='max'or raw.isdigit()
 value=None if raw=='max'else int(raw)
 if value is not None:assert value>=10*1024**3,'Effective memory parent below compiler budget'
 limits.append({'path':str(f),'value':raw})
config=Path('/etc/docker/daemon.json')
if config.exists():
 d=json.loads(config.read_text());assert d.get('cgroup-parent','system.slice')in('system.slice','/system.slice'),'Unknown engine cgroup parent'
result.write_text(json.dumps({'state':'SOURCE_POLICY_8GIB_HOST_ADMISSION_PASS','engineMemTotal':info['MemTotal'],'engineMemoryAndSwapLimitCapable':True,'cgroupVersion':info['CgroupVersion'],'cgroupDriver':info['CgroupDriver'],'explicitProducerCgroupParent':'system.slice','host':memory,'effectiveMemoryLimits':limits,'noMemoryFitOrRuntimeClaim':True},indent=2)+'\n')
