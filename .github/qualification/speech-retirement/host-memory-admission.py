"""Hosted-only read-only effective8GiB memory gate, with bounded partial diagnostics."""
from pathlib import Path
import hashlib,json,os,re,subprocess,sys
result=Path(sys.argv[1]);partial=result.with_name('HOST-MEMORY-PARTIAL.json')
observed={};stage='hosted-scope'
def checkpoint(name,values=None,error=None):
 global stage
 stage=name
 if values:observed.update(values)
 data={'state':'PARTIAL_HOST_METADATA_NOT_ADMISSION','stage':stage,'observed':observed,'error':error}
 text=json.dumps(data,indent=2)+'\n';assert len(text.encode())<=32768
 partial.write_text(text)
try:
 assert sys.platform=='linux'and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'and os.environ.get('GITHUB_REPOSITORY')=='elizaOS/eliza','Hosted Linux scope only; no local Docker action admitted'
 contract_path=Path(__file__).resolve().parent/'SUPPORTED-KERNEL-NAMESPACE-PROOF.json'
 contract_bytes=contract_path.read_bytes();assert len(contract_bytes)<=32768
 contract=json.loads(contract_bytes);assert contract['schemaVersion']==1
 checkpoint('kernel-release-observation',{'kernelRelease':os.uname().release,'kernelProofContractSHA256':hashlib.sha256(contract_bytes).hexdigest(),'kernelProofSourceCommit':contract['sourceCommit']})
 assert os.environ.get('DOCKER_HOST')=='unix:///var/run/docker.sock'and not os.environ.get('DOCKER_CONTEXT')
 for key in ['DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION']:assert not os.environ.get(key)
 checkpoint('engine-info')
 info=json.loads(subprocess.check_output(['docker','info','--format','{{json .}}'],timeout=10))
 checkpoint('engine-budget',{'engine':{key:info.get(key)for key in ['OSType','Architecture','MemoryLimit','SwapLimit','CgroupVersion','CgroupDriver','MemTotal']}})
 assert info['OSType']=='linux'and info['Architecture']=='x86_64'
 assert info['MemoryLimit']and info['SwapLimit']and info['CgroupVersion']=='2'and info['CgroupDriver']=='systemd'
 assert info['MemTotal']>=15*1024**3,'Engine below compiler host profile'
 context=json.loads(subprocess.check_output(['docker','context','inspect'],timeout=10));assert len(context)==1
 assert context[0]['Endpoints']['docker']['Host']=='unix:///var/run/docker.sock','Remote or unknown engine not admitted'
 memory={line.split(':',1)[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()if line.startswith(('MemTotal:','MemAvailable:'))}
 checkpoint('host-budget',{'host':memory})
 assert memory['MemTotal']>=15*1024**3 and memory['MemAvailable']>=10*1024**3,'Host budget insufficient'
 own=Path('/proc/self/cgroup').read_text().splitlines();assert len(own)==1 and own[0].startswith('0::/')
 relative=own[0][3:];assert '..'not in Path(relative).parts
 mounts=Path('/proc/self/mountinfo').read_text().splitlines();cgroups=[x for x in mounts if' - cgroup2 'in x];assert len(cgroups)==1
 left=cgroups[0].split(' - ',1)[0].split();assert left[3]=='/'and left[4]=='/sys/fs/cgroup','Unknown effective cgroup namespace'
 root=Path('/sys/fs/cgroup');paths=set();p=root/relative.lstrip('/')
 while p!=root:
  assert p.is_relative_to(root);paths.add(p);p=p.parent
 paths.add(root);paths.add(root/'system.slice');limits=[]
 checkpoint('effective-ancestor-limits',{'runnerCgroup':own[0],'selectedProducerParent':'system.slice','effectiveMemoryLimits':limits})
 for p in sorted(paths):
  f=p/'memory.max'
  if not f.exists():
   assert p==root and not f.is_symlink(),'Unknown effective memory ceiling: '+str(p)
   assert Path('/proc/1/comm').read_text().strip()=='systemd'
   assert Path('/proc/1/cgroup').read_text().strip()=='0::/init.scope'
   # Version-bound reserved initial inode proof replaces inaccessible PID1
   # namespace readlink. It is not a magic value applied to arbitrary kernels.
   supported=contract['supportedRuntime']
   checkpoint('kernel-source-binding')
   with Path('/proc/version_signature').open('rb')as stream:signature_bytes=stream.read(513)
   assert len(signature_bytes)<=512,'Kernel signature metadata bound'
   signature=signature_bytes.decode('ascii').strip()
   checkpoint('kernel-source-binding',{'kernelVersionSignature':signature})
   assert os.uname().release==supported['unameRelease']and signature==supported['procVersionSignature']and os.uname().machine==supported['architecture'],'Unknown kernel source contract; root-absence proof not admitted'
   initial=contract['symbols']['CGROUP_NS_INIT_INO']['decimal'];dynamic=contract['symbols']['PROC_DYNAMIC_FIRST']['decimal']
   assert type(initial)is int and type(dynamic)is int and int(contract['symbols']['CGROUP_NS_INIT_INO']['hex'],16)==initial and int(contract['symbols']['PROC_DYNAMIC_FIRST']['hex'],16)==dynamic and 0<initial<dynamic<=0xffffffff,'Invalid version-bound namespace symbol contract'
   checkpoint('own-initial-cgroup-namespace',{'initialNamespaceNamedSymbol':'CGROUP_NS_INIT_INO (PROC_CGROUP_INIT_INO alias)','sourceBoundInitialInode':initial,'sourceBoundChildAllocationMinimum':dynamic,'namespaceFDOpened':False,'namespaceFDClosed':None})
   descriptor=os.open('/proc/self/ns/cgroup',os.O_RDONLY|os.O_CLOEXEC)
   observed['namespaceFDOpened']=True
   try:
    metadata=os.fstat(descriptor);own_namespace=os.readlink('/proc/self/ns/cgroup')
    match=re.fullmatch(r'cgroup:\[([0-9]+)\]',own_namespace)
    checkpoint('own-initial-cgroup-namespace',{'ownCgroupNamespace':own_namespace,'ownNamespaceInode':metadata.st_ino,'ownNamespaceDevice':metadata.st_dev})
    assert match and int(match.group(1))==metadata.st_ino==initial,'Runner cgroup namespace is not the source-bound initial namespace'
   finally:
    os.close(descriptor);observed['namespaceFDClosed']=True
   method='unprivileged-own-namespace-fd-and-readlink-matched-version-bound-reserved-inode'
   checkpoint('initial-cgroup-namespace-proved',{'initialNamespaceReadMethod':method,'kernelProofContractSHA256':hashlib.sha256(contract_bytes).hexdigest()})
   assert 'memory'in(root/'cgroup.controllers').read_text().split()
   # Kernel cgroup.type, like memory.max, is a non-root interface. Require
   # domain at the selected non-root producer parent; inspect root type only
   # if it is exposed. Never invent a missing root type or memory ceiling.
   parent_type=(root/'system.slice/cgroup.type').read_text().strip();assert parent_type=='domain'
   type_file=root/'cgroup.type'
   if type_file.exists():
    assert type_file.is_file()and not type_file.is_symlink()and type_file.read_text().strip()=='domain'
    root_type='domain'
   else:
    assert not type_file.is_symlink();root_type='ABSENT_DOCUMENTED_NONROOT_ONLY_INTERFACE'
   limits.append({'path':str(f),'value':'ABSENT_KERNEL_HIERARCHY_ROOT','rootChecked':True,'sourceBoundInitialCgroupNamespaceVerified':True,'initialNamespaceReadMethod':method,'kernelProofContractSHA256':hashlib.sha256(contract_bytes).hexdigest(),'selectedParentType':parent_type,'rootType':root_type,'semanticSource':'https://docs.kernel.org/admin-guide/cgroup-v2.html#core-interface-files'})
   checkpoint('effective-ancestor-limits')
   continue
  assert f.is_file()and not f.is_symlink(),'Unknown effective memory ceiling: '+str(p)
  raw=f.read_text().strip();assert raw=='max'or raw.isdigit()
  value=None if raw=='max'else int(raw)
  limits.append({'path':str(f),'value':raw});checkpoint('effective-ancestor-limits')
  if value is not None:assert value>=10*1024**3,'Effective memory parent below compiler budget'
 config=Path('/etc/docker/daemon.json')
 if config.exists():
  d=json.loads(config.read_text());assert d.get('cgroup-parent','system.slice')in('system.slice','/system.slice'),'Unknown engine cgroup parent'
 result.write_text(json.dumps({'state':'SOURCE_POLICY_8GIB_HOST_ADMISSION_PASS','engineMemTotal':info['MemTotal'],'engineMemoryAndSwapLimitCapable':True,'cgroupVersion':info['CgroupVersion'],'cgroupDriver':info['CgroupDriver'],'explicitProducerCgroupParent':'system.slice','host':memory,'effectiveMemoryLimits':limits,'noMemoryFitOrRuntimeClaim':True,'partialMetadata':partial.name},indent=2)+'\n')
 checkpoint('complete-host-gate')
except BaseException as error:
 checkpoint(stage,error={'type':type(error).__name__,'message':str(error)[:2048]})
 raise
