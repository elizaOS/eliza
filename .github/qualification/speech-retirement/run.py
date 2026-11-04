"""Finite normal whole-file ordinal qualification. SOURCE ONLY: no admitted subject yet."""
import collections,hashlib,json,os,pathlib,re,selectors,signal,shutil,subprocess,sys,time
P=pathlib.Path(__file__).resolve().parent
assert len(sys.argv)==3
source=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
plan=json.loads((P/'PLAN.json').read_text());manifest=json.loads((P/'SOURCE-MANIFEST.json').read_text());oracle=json.loads((P/'ORACLES.json').read_text());resource_policy=json.loads((P/'TEST-RESOURCE-POLICY.json').read_text())
for name,want in json.loads((P/'SEAL.json').read_text())['files'].items():assert sha(P/name)==want,name
assert re.fullmatch('[a-f0-9]{40}',manifest['commit']) and re.fullmatch('[a-f0-9]{40}',manifest['tree']),'Reviewed test-only successor must be published/rebound before admission'
go_path=pathlib.Path(os.environ['ROOT_GO_JSON']).resolve();go=json.loads(go_path.read_text())
assert go['action']=='ONE_EXACT_QUALIFICATION_RUN' and go['recipe']=='ordinal-normal-producer-qualification' and go['mode']=='qualify'
assert go['allowHostedFrozenLockSetup'] is True and go['allowHostedWholeFileTests'] is True and go['allowLoopbackWireFixture'] is True
assert go['diagnosticOnly'] is False and go['allowNormalOwnedWorkspaceProducers'] is True and go['allowProducerSourceWrite'] is True and go['allowOrdinaryCLIObservation'] is True and go['allowPostCLIValuePreflight'] is True
assert go['allowHostedUnusedAndroidCleanup'] is False and go['allowExternalProviders'] is False and go['allowSourceOverlay'] is False
assert go['expectedRegistrations']==go['expectedPassed']==113 and go['expectedUnexecuted']==0
assert go['workflowCommit']==os.environ['GITHUB_SHA']==os.environ['EXPECTED_WORKFLOW_SHA']
assert go['sourceCommit']==manifest['commit'] and go['sourceTree']==manifest['tree']
assert go['operatorSealSHA256']==sha(P/'SEAL.json')
for key,n in [('planSHA256','PLAN.json'),('oracleSHA256','ORACLES.json'),('testResourcePolicySHA256','TEST-RESOURCE-POLICY.json'),('hostCohortsSHA256','HOST-COHORTS.json'),('sourceManifestSHA256','SOURCE-MANIFEST.json'),('producerGraphSHA256','EXPECTED-GRAPH.json'),('sourceCustodySHA256','SOURCE-CUSTODY.json')]:assert go[key]==sha(P/n)
assert 0<go['issuedEpoch']<=time.time()<go['expiresEpoch']<=go['issuedEpoch']+1200 and re.fullmatch('[a-f0-9]{32}',go['intentId'])
assert os.environ['GITHUB_RUN_ATTEMPT']=='1' and os.environ['RUNNER_ENVIRONMENT']=='github-hosted' and os.environ['GITHUB_REPOSITORY']=='elizaOS/eliza' and os.environ['GITHUB_EVENT_NAME']=='workflow_dispatch'
host_policy=json.loads((P/'HOST-COHORTS.json').read_text());runner_metadata={}
for key,spec in host_policy['metadataFields'].items():
 value=os.environ.get(spec['environment']);runner_metadata[key]=value if value is None or len(value)<=spec['maxChars'] else {'overBound':True,'length':len(value)}
metadata_line=json.dumps({'state':'OBSERVED_RUNNER_METADATA_NOT_ADMISSION','fields':runner_metadata},separators=(',',':'));assert len(metadata_line.encode())<=4096
print(metadata_line,flush=True)
assert go['hostProvenanceDisclosure']==plan['hostProvenanceDisclosure']
assert sys.platform=='linux' and os.uname().machine=='x86_64' and (3,12)<=sys.version_info[:2]<(3,16)
assert hasattr(os,'waitid') and hasattr(os,'WNOWAIT') and pathlib.Path('/proc/self/stat').is_file()
assert os.environ.get('ImageOS')==host_policy['ImageOS'] and os.environ.get('ImageVersion') in host_policy['allowedImageVersions']
assert source==pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()/'source' and str(out)==go['output'] and out.is_relative_to(pathlib.Path(os.environ['RUNNER_TEMP']).resolve()) and not out.exists()
claim=json.loads((pathlib.Path(os.environ['RUNNER_TEMP'])/'speech-intent-claim.json').read_text())
assert claim['actualRunId']==os.environ['GITHUB_RUN_ID'] and claim['attempt']==1 and claim['rootGOsha256']==sha(go_path)
metadata_path=pathlib.Path(os.environ['RUNNER_TEMP'])/'ordinal-admission.json';assert sha(metadata_path)==claim['runnerMetadataSHA256'] and json.loads(metadata_path.read_text())['fields']==runner_metadata
for key in ['intentId','workflowCommit','sourceCommit','sourceTree','operatorSealSHA256','planSHA256','oracleSHA256','testResourcePolicySHA256','hostCohortsSHA256','sourceManifestSHA256','hostProvenanceDisclosure','expectedRegistrations','expectedPassed','expectedUnexecuted','diagnosticOnly','allowNormalOwnedWorkspaceProducers','allowProducerSourceWrite','producerGraphSHA256','sourceCustodySHA256','allowOrdinaryCLIObservation','allowPostCLIValuePreflight','allowHostedFrozenLockSetup','allowHostedWholeFileTests','allowLoopbackWireFixture','allowHostedUnusedAndroidCleanup','allowExternalProviders','allowSourceOverlay','issuedEpoch','expiresEpoch']:assert claim[key]==go[key],key
import urllib.request
artifact_id=os.environ['CLAIM_ARTIFACT_ID'];assert artifact_id.isdigit()
request=urllib.request.Request('https://api.github.com/repos/elizaOS/eliza/actions/artifacts/'+artifact_id,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
with urllib.request.urlopen(request,timeout=20) as response:artifact=json.load(response)
assert artifact['name']=='speech-intent-'+go['intentId'] and artifact['workflow_run']['id']==int(os.environ['GITHUB_RUN_ID']) and not artifact['expired']
with go_path.with_suffix('.consumed').open('x') as f:f.write('consumed')
out.mkdir();start=time.monotonic();free_start=shutil.disk_usage(out).free
records=[];owned=[];status='FAILED';run_error=None;cleanup_errors=[];family_results={}
(out/'RUNNER-METADATA.json').write_bytes(metadata_path.read_bytes())
runid=os.environ['GITHUB_RUN_ID'];assert runid.isdigit();prefix='speech-retirement-'+runid+'-1-ordinal-normal'
assert resource_policy['defaultTest']=={'memory':'2g','memoryBytes':2147483648,'nodeOldSpaceMiB':1536} and resource_policy['memorySwapEqualsMemory'] is True
for key in ['DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_CONFIG','DOCKER_API_VERSION']:assert not os.environ.get(key),'Inherited Docker override not admitted'
assert os.environ.get('DOCKER_HOST','unix:///var/run/docker.sock')=='unix:///var/run/docker.sock' and os.environ.get('DOCKER_CONTEXT','default')=='default'
os.environ['DOCKER_HOST']='unix:///var/run/docker.sock';os.environ.pop('DOCKER_CONTEXT',None)
docker_config=out.parent/('ordinal-docker-config-'+runid);docker_config.mkdir();os.environ['DOCKER_CONFIG']=str(docker_config)
class PhaseExitError(RuntimeError):
 def __init__(self,phase_name,code):
  super().__init__(f'{phase_name} exited {code}');self.phase_name=phase_name;self.code=code

def identity(pid):
 try:
  fields=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
  return {'state':fields[0],'pgid':int(fields[2]),'birth':fields[19]}
 except FileNotFoundError:return None

def group_members(pgid):
 result=[]
 for entry in pathlib.Path('/proc').iterdir():
  if not entry.name.isdigit():continue
  value=identity(int(entry.name))
  if value and value['pgid']==pgid and value['state']!='Z':result.append(int(entry.name))
 return result

def phase(name,args,timeout,accepted=(0,),cleanup=False):
 begin=time.monotonic();log=out/(name+'.log');written=0;proc=None;birth=None;empty=False;code=None;error=None;sel=None
 def signal_owned(sig):
  current=identity(proc.pid)
  assert current and current['birth']==birth and current['pgid']==proc.pid,'Lost child/PGID custody'
  os.killpg(proc.pid,sig)
 try:
  if not cleanup:
   assert time.time()<go['expiresEpoch'], 'Root GO expired'
   free=shutil.disk_usage(out).free
   if free<plan['resourceBounds']['stopFreeBytes'] or free_start-free>plan['resourceBounds']['maxDiskGrowthBytes']:raise RuntimeError('disk bound before launch')
   if time.monotonic()-start>1200:raise RuntimeError('whole-job wall bound before launch')
  # Reserve the exclusive receipt before starting any child. A duplicate path
  # must fail with proc=None, preserving the original log and spawning nothing.
  with log.open('xb') as stream:
   proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
   first=identity(proc.pid);assert first and first['pgid']==proc.pid;birth=first['birth']
   os.set_blocking(proc.stdout.fileno(),False);sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ)
   def drain(wait=0):
    nonlocal written
    for key,_ in sel.select(wait):
     data=os.read(key.fileobj.fileno(),65536)
     if not data:sel.unregister(key.fileobj);continue
     written+=len(data)
     if written>8*1024**2:raise RuntimeError('phase log cap')
     stream.write(data);stream.flush()
   while True:
    drain(.1)
    if time.monotonic()-begin>timeout:raise RuntimeError('phase wall bound')
    if not cleanup:
     assert time.time()<go['expiresEpoch'], 'Root GO expired'
     free=shutil.disk_usage(out).free
     if free<plan['resourceBounds']['stopFreeBytes'] or free_start-free>plan['resourceBounds']['maxDiskGrowthBytes']:raise RuntimeError('disk bound')
     if time.monotonic()-start>1200:raise RuntimeError('whole-job wall bound')
    # WNOWAIT deliberately retains the leader identity until its group is empty.
    if os.waitid(os.P_PID,proc.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT):
     deadline=time.monotonic()+1
     while group_members(proc.pid) and time.monotonic()<deadline:drain(.05)
     if group_members(proc.pid):raise RuntimeError('Descendant outlived leader')
     empty=True
     for _ in range(20):
      drain(.01)
      if not sel.get_map():break
     break
  code=proc.wait(timeout=2)
  if code not in accepted:raise PhaseExitError(name,code)
 except BaseException as exc:error=type(exc).__name__+': '+str(exc);raise
 finally:
  if proc and not empty:
   try:
    if group_members(proc.pid):signal_owned(signal.SIGTERM)
    deadline=time.monotonic()+1
    while group_members(proc.pid) and time.monotonic()<deadline:time.sleep(.05)
    if group_members(proc.pid):signal_owned(signal.SIGKILL)
    deadline=time.monotonic()+2
    while group_members(proc.pid) and time.monotonic()<deadline:time.sleep(.05)
    empty=not group_members(proc.pid)
    if empty:code=proc.wait(timeout=2)
   except BaseException as exc:error=(error or '')+'; cleanup '+str(exc)
  if proc is None:empty=True
  if sel is not None:sel.close()
  records.append({'phase':name,'seconds':time.monotonic()-begin,'exit':code,'acceptedExit':code in accepted,'error':error,'logBytes':written,'leaderBirth':birth,'ownedGroupEmpty':empty})
  if proc and proc.stdout:proc.stdout.close()
  if not empty:raise RuntimeError('Unclosed owned process group')
 return log.read_text(),code

inspect_format='{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Error":{{json .State.Error}}}}'
resource_inspect_format='{"CgroupParent":{{json .HostConfig.CgroupParent}},"Ulimits":{{json .HostConfig.Ulimits}},"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Error":{{json .State.Error}}},"Resources":{"memoryBytes":{{json .HostConfig.Memory}},"memorySwapBytes":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"pidsLimit":{{json .HostConfig.PidsLimit}},"nodeOptions":{{$nodeOptions := ""}}{{range .Config.Env}}{{if eq (printf "%.13s" .) "NODE_OPTIONS="}}{{$nodeOptions = .}}{{end}}{{end}}{{json $nodeOptions}}}}'
def inspect_container(key,label,cleanup=False,resources=False):
 text,code=phase(label,['docker','container','inspect','--format',resource_inspect_format if resources else inspect_format,key],10,accepted=(0,1),cleanup=cleanup)
 if code==1:
  assert 'No such object' in text or 'No such container' in text,'Container lookup failed ambiguously'
  return None
 return json.loads(text)

def check_container(value,item):
 assert re.fullmatch('[a-f0-9]{64}',value['Id']) and value['Name']=='/'+item['name']
 if item['cid'] is not None:assert value['Id']==item['cid']
 assert value['Labels']['org.eliza.qualification-run']==runid and value['Labels']['org.eliza.qualification-kind']=='speech-retirement'

class ResourcePolicyError(RuntimeError):
 pass

def check_resources(value,item,label):
 if item.get('cgroupParent')is not None and value.get('CgroupParent')!=item['cgroupParent']:
  item.setdefault('resourcePolicyFailures',[]).append({'where':label,'expectedCgroupParent':item['cgroupParent'],'actualCgroupParent':value.get('CgroupParent')});raise ResourcePolicyError('Actual producer cgroup parent differs from checked hierarchy')
 if item.get('metadataFileSizeLimitBytes')is not None:
  expected=[{'Name':'fsize','Hard':8388608,'Soft':8388608}]
  if value.get('Ulimits')!=expected:
   item.setdefault('resourcePolicyFailures',[]).append({'where':label,'expectedUlimits':expected,'actualUlimits':value.get('Ulimits')});raise ResourcePolicyError('Wrong actual metadata hard file-size limit')
 actual=value.get('Resources')
 if actual!=item['resources']:
  item.setdefault('resourcePolicyFailures',[]).append({'where':label,'expected':item['resources'],'actual':actual})
  raise ResourcePolicyError('Actual Docker resource/Node heap policy mismatch')

def cleanup_container(item,label):
 key=item['cid'] or item['name'];policy_failure=None
 try:
  value=inspect_container(key,label+'-identity',cleanup=True,resources=True)
 except BaseException as exc:
  # A failed resource probe must not prevent custody-only owned cleanup.
  item.setdefault('resourcePolicyFailures',[]).append({'where':label,'resourceInspectionError':type(exc).__name__+': '+str(exc)})
  policy_failure=ResourcePolicyError('Resource inspection failed during owned cleanup')
  value=inspect_container(key,label+'-owner-only-identity',cleanup=True)
 if value:
  check_container(value,item);item['cid']=value['Id']
  if policy_failure is None:
   try:check_resources(value,item,label)
   except ResourcePolicyError as exc:policy_failure=exc
  phase(label+'-remove',['docker','rm','-f',item['cid']],10,cleanup=True)
  assert inspect_container(item['cid'],label+'-absence',cleanup=True) is None
 elif not item['createCompleted']:
  raise RuntimeError('Container creation outcome unknown; no matching container observed')
 item['closed']=True
 if policy_failure:raise policy_failure

def container_phase(name,network,memory,command,timeout,rw=False,test_family=False,cwd="/workspace",node_old_space_mib=None):
 assert (name=="install" and network=="bridge" and rw) or (name in ["normal-producer-graph","normal-producers"] and network=="none" and rw) or (name not in ["install","normal-producer-graph","normal-producers"] and network=="none" and not rw)
 if name=="normal-producers":assert memory=="8g" and node_old_space_mib==4096
 else:assert memory in ("2g","4g") and node_old_space_mib in (None,1024,1536)
 if node_old_space_mib is None:node_old_space_mib=resource_policy['defaultTest']['nodeOldSpaceMiB']
 assert memory in ('2g','4g','8g') and node_old_space_mib in (1024,1536,4096)
 memory_bytes=int(memory[:-1])*1024**3
 resources={'memoryBytes':memory_bytes,'memorySwapBytes':memory_bytes,'nanoCpus':2000000000,'pidsLimit':256,'nodeOptions':'NODE_OPTIONS=--max-old-space-size='+str(node_old_space_mib)}
 cname=prefix+'-'+name
 assert inspect_container(cname,name+'-absence') is None,'Preexisting container name; no mutation'
 args=['docker','create','--pull=never','--name',cname,'--label','org.eliza.qualification-run='+runid,'--label','org.eliza.qualification-kind=speech-retirement','--network',network,'--cpus','2','--memory',memory,'--memory-swap',memory,'--pids-limit','256','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,size=536870912','--mount','type=bind,src='+str(source)+',dst=/workspace'+('' if rw else ',readonly'),'--mount','type=bind,src='+str(out)+',dst=/results','--workdir',cwd,'--env','HOME=/tmp/home','--env','TMPDIR=/tmp','--env','CI=true','--env','NODE_ENV=test','--env',resources['nodeOptions'],'--env','ELIZA_VAULT_DISABLE_KEYCHAIN=1','--env','ELIZA_LIVE_TEST=0','--env','BUN_INSTALL_CACHE_DIR='+('/workspace/.cache/qualification-bun' if name=='install' else '/tmp/bun-cache'),'--env','BUN_CONFIG_NO_AUTO_INSTALL=true','--env','VITEST_FS_MODULE_CACHE_PATH=/results/module-cache-'+name,'--entrypoint',command[0],image,*command[1:]]
 if re.fullmatch('owning-[0-2]',name):
  at=args.index('--entrypoint');args[at:at]=['--env','ORDINAL_DIAGNOSTIC_PHASE='+name]
  node_index=args.index(resources['nodeOptions']);resources['nodeOptions']+=' --require=/results/ordinary-node-conditions.cjs';args[node_index]=resources['nodeOptions']
 # Register intent before the daemon can create anything. A lost CLI reply
 # is reconciled by exact name AND run labels, never removed by name alone.
 if name in ['normal-producer-graph','normal-producers']:
  at=args.index('--entrypoint');args[at:at]=['--env','RUN_TURBO_CONCURRENCY=1']
 if name=='normal-producers':
  at=args.index('--entrypoint');args[at:at]=['--cgroup-parent','system.slice']
 if name=='normal-producer-graph':
  at=args.index('--entrypoint');args[at:at]=['--ulimit','fsize=8388608:8388608']
 item={'cid':None,'name':cname,'createCompleted':False,'resources':resources};owned.append(item)
 if name=='normal-producer-graph':item['metadataFileSizeLimitBytes']=8388608
 if name=='normal-producers':item['cgroupParent']='system.slice'
 text,_=phase(name+'-create',args,20);cid=text.strip();assert re.fullmatch('[a-f0-9]{64}',cid)
 item['cid']=cid;item['createCompleted']=True
 value=inspect_container(cid,name+'-identity',resources=True);check_container(value,item);check_resources(value,item,name+'-identity')
 failure=None
 try:phase(name,['docker','start','--attach',cid],timeout)
 except PhaseExitError as exc:
  if not test_family or exc.phase_name!=name:raise
  failure=exc
 value=inspect_container(cid,name+'-postidentity',resources=True);check_container(value,item);check_resources(value,item,name+'-postidentity')
 state=value['State']
 if state['Running'] or state['Status']!='exited' or state['OOMKilled'] or state['Error']:
  raise RuntimeError('Container did not reach an ordinary non-OOM exited state')
 if state['ExitCode']!=(failure.code if failure else 0) or state['ExitCode']>=128:
  raise RuntimeError('Container exit identity/signal is not a clean test result')
 # Continuation is permitted only after both the CLI group and exact CID close.
 cleanup_container(item,'after-'+name)
 return failure

def normalized_report_file(raw,cwd):
 if not isinstance(raw,str) or not raw or "\\" in raw:raise ValueError('Missing or non-POSIX report file')
 value=pathlib.PurePosixPath(raw)
 if '..' in value.parts:raise ValueError('Report file traversal')
 if value.is_absolute():return str(value.relative_to('/workspace'))
 if value.parts and value.parts[0]=='packages':return str(value)
 return str(pathlib.PurePosixPath(cwd)/value)

def verify_source():
 assert sha(source/'bun.lock')==manifest['bunLockSHA256']
 for name,want in manifest['files'].items():assert sha(source/name)==want,name
 env=dict(os.environ,GIT_NO_LAZY_FETCH='1',GIT_NO_REPLACE_OBJECTS='1',GIT_OPTIONAL_LOCKS='0')
 def git(*args,allowed=(0,)):
  remaining=min(10.0,go['expiresEpoch']-time.time(),1200-(time.monotonic()-start))
  assert remaining>0,'No remaining finite source-metadata window'
  result=subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',str(source),*args],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=remaining)
  assert result.returncode in allowed,'Source metadata read failed'
  return result.stdout.strip()
 assert not git('config','--local','--get-regexp',r'^(http\..*\.extraheader|credential\.|core\.sshcommand|include\.|includeif\.|url\..*\.insteadof)',allowed=(0,1)), 'Credential-bearing or indirect local Git config not admitted'
 assert git('config','--local','--get','remote.origin.url') in ['https://github.com/elizaOS/eliza.git','https://github.com/elizaOS/eliza'], 'Unexpected or credential-bearing source origin'
 assert git('rev-parse','HEAD')==manifest['commit'] and git('rev-parse','HEAD^{tree}')==manifest['tree']
 assert not git('diff','--no-ext-diff','--name-only','HEAD')
 assert not git('ls-files','--others','--exclude-standard'), 'Untracked source overlay'
 assert not any(x.startswith('S ') or x[:1].islower() for x in git('ls-files','-v').splitlines())
 custody=json.loads((P/'SOURCE-CUSTODY.json').read_text())
 for name,want in custody['sourceTreePins'].items():assert git('rev-parse','HEAD:'+name)==want
 for name,want in custody['extraNormalHelperGitBlobPins'].items():assert git('rev-parse','HEAD:'+name)==want
 for directory in [source,*[source/x for x in ['plugins/plugin-assistant','plugins/plugin-openai','packages/core','packages/host','packages/testing','plugins/plugin-sqlite']]]:
  for name in ['.env','.env.local','.env.test','.env.test.local','.env.development','.env.development.local','.env.production','.env.production.local','.dev.vars','.dev.vars.production']:
   assert not (directory/name).exists() and not (directory/name).is_symlink(), 'Credential-bearing environment file not admitted'

def verify_dependencies(stage):
 assert stage in ['initial','after-graph','after-producer','after-outputs','final'],'Unknown verification receipt stage'
 receipt=out/'DEPENDENCY-INVENTORY.json';d=json.loads(receipt.read_text())
 assert d['sourceCommit']==manifest['commit'] and d['sourceTree']==manifest['tree'] and d['bunLockSHA256']==manifest['bunLockSHA256'] and d['ignoreScripts'] is True and d['nativeHooksExecuted'] is False
 assert sha(out/'dependency-files.jsonl')==d['inventorySHA256']
 phase('verify-installed-dependencies-'+stage,[sys.executable,'-I','-B',str(P/'inventory_dependencies.py'),'verify',str(source),str(out),manifest['commit'],manifest['tree'],manifest['bunLockSHA256']],90)
 return d['inventorySHA256']

def fresh_module_cache(name):
 assert re.fullmatch('[a-z0-9-]{1,64}',name)
 directory=out/name;directory.mkdir(mode=0o700)
 value=directory.lstat();parent=out.stat()
 assert not directory.is_symlink() and directory.is_dir() and value.st_dev==parent.st_dev and value.st_uid==os.getuid() and (value.st_mode&0o777)==0o700 and not any(directory.iterdir())
 (out/('CACHE-ADMISSION-'+name+'.json')).write_text(json.dumps({'state':'FRESH_OWNED_WRITABLE_MODULE_CACHE_NOT_SOURCE_OR_TEST_PASS','path':'/results/'+name,'uid':value.st_uid,'device':value.st_dev,'inode':value.st_ino,'entriesBefore':0,'retainedCacheContents':False},indent=2)+'\n')

def observe_ordinary(group,failure,command):
 row={'file':group['file'],'sourceSHA256':next(x['sha256']for x in oracle['files']if x['path']==group['file']),'attempts':1,'CLIArgv':command,'cwd':group['cwd'],'expectedSourceRegistrations':group['registrations'],'ordinaryCLIExit':failure.code if failure else 0,'reportPresent':False,'actualRegistered':None,'actualPassed':None,'actualFailed':None,'actualPending':None,'actualTodo':None,'exactNamesMatch':None,'reportErrors':[],'assertions':[],'qualification':False}
 report=out/group['report']
 try:
  assert report.is_file() and not report.is_symlink() and report.stat().st_size<=8388608,'Missing/oversized/nonordinary report'
  data=json.loads(report.read_text());row['reportPresent']=True;row['reportSHA256']=sha(report)
  for src,dst in [('numTotalTests','actualRegistered'),('numPassedTests','actualPassed'),('numFailedTests','actualFailed'),('numPendingTests','actualPending'),('numTodoTests','actualTodo')]:
   value=data.get(src);assert type(value)is int and value>=0,'Invalid normalreport count';row[dst]=value
  rows=data.get('testResults');assert isinstance(rows,list)and len(rows)<=8
  match=[r for r in rows if normalized_report_file(r['name'],group['cwd'].removeprefix('/workspace/'))==group['file']]
  assert len(match)==1 and len(rows)==1,'Wrong/multiple/missing wholefile report identity'
  actual=match[0].get('assertionResults');assert isinstance(actual,list)and len(actual)<=4096
  remaining_detail_bytes=65536
  for item in actual:
   name=item.get('fullName');status=item.get('status');assert isinstance(name,str)and len(name)<=16384 and status in ['passed','failed','pending','todo','skipped','disabled'],'Invalid assertion identity/status'
   messages=item.get('failureMessages',[]);assert isinstance(messages,list)
   # Preserve all assertion identities/statuses and bounded explicit firsterror details.
   details=[];truncated=len(messages)>3
   for message in messages[:3]:
    raw=str(message).encode('utf-8',errors='replace');take=min(16384,remaining_detail_bytes);piece=raw[:take].decode('utf-8',errors='replace');details.append(piece);remaining_detail_bytes-=min(len(raw),take);truncated=truncated or len(raw)>take
   row['assertions'].append({'name':name,'status':status,'failureMessages':details,'failureDetailTruncated':truncated})
  expected=next(x for x in oracle['files']if x['path']==group['file'])
  row['exactNamesMatch']=collections.Counter(x['name']for x in row['assertions'])==collections.Counter(x['name']for x in expected['tests'])
  row['fileStatus']=match[0].get('status');row['fileMessage']=str(match[0].get('message',''))[:32768]
 except (OSError,ValueError,KeyError,AssertionError,TypeError)as exc:
  row['reportErrors'].append(type(exc).__name__+': '+str(exc))
 row['ordinaryConditionsFilePresent']=(out/('CLI-CONDITIONS-'+group['name']+'.json')).is_file()
 row['nodeConditionsFiles']=[x.name for x in out.glob('NODE-CONDITIONS-'+group['name']+'-*.json')]
 row['conditionObservationGap']=not row['ordinaryConditionsFilePresent'] or not row['nodeConditionsFiles']
 row['conditionObservationErrors']=[]
 try:
  metadata_file=out/('CLI-CONDITIONS-'+group['name']+'.json');assert metadata_file.stat().st_size<=32768
  metadata=json.loads(metadata_file.read_text());assert metadata['phase']==group['name'] and metadata['projects']
  wanted_root=group['cwd'];projects=[x for x in metadata['projects']if x['root']==wanted_root]
  assert len(projects)==1 and projects[0]['configFile']==wanted_root+'/vitest.config.ts'
  for key in ['workerTransportConditions','workerTransportExternalConditions','ssrConditions','ssrExternalConditions']:
   assert isinstance(projects[0][key],list)and all(isinstance(x,str)for x in projects[0][key]),'Missing actual worker/SSR conditions'
  nodes=[]
  for filename in row['nodeConditionsFiles']:
   f=out/filename;assert not f.is_symlink()and f.stat().st_size<=8192
   item=json.loads(f.read_text());assert item['phase']==group['name']and item['cwd']==wanted_root and item['node']=='24.15.0';nodes.append(item)
  parents={x['pid']for x in nodes}
  workers=[x for x in nodes if x['ppid']in parents and 'node'in x['nodeExplicitConditions']]
  assert workers,'No actual ordinary fork worker Node condition observation'
  row['ordinaryWorkerNodePIDs']=[x['pid']for x in workers]
  row['CLIConditionsSHA256']=sha(metadata_file)
 except (OSError,ValueError,KeyError,TypeError,AssertionError)as exc:
  row['conditionObservationGap']=True;row['conditionObservationErrors'].append(type(exc).__name__+': '+str(exc))

 row['scope']='OrdinaryCLI observation retained independently; aggregate qualification requires every final gate and cleanup.'
 encoded=(json.dumps(row,indent=2)+'\n').encode();assert len(encoded)<=524288,'Diagnostic metadata cap; rawreporthash retained'
 (out/('OBSERVATION-'+group['name']+'.json')).write_bytes(encoded)
 family_results[group['file']]=row

try:
 assert free_start>=plan['resourceBounds']['minimumStartFreeBytes']
 (out/'runner.json').write_text(json.dumps({'ImageOS':os.environ['ImageOS'],'ImageVersion':os.environ['ImageVersion'],'runId':runid,'attempt':1,'freeStartBytes':free_start},indent=2)+'\n')
 text,_=phase('docker-endpoint',['docker','context','inspect','default','--format','{{json .Endpoints.docker.Host}}'],10);assert json.loads(text)=='unix:///var/run/docker.sock'
 text,_=phase('docker-version',['docker','version','--format','{{.Server.Version}}'],10);assert text.strip()==plan['reviewedRunner']['dockerServer']
 text,_=phase('docker-platform',['docker','info','--format','{{.OSType}}/{{.Architecture}}'],10);assert text.strip()=='linux/x86_64'
 guard,_=phase('known-incident-source-guard',[sys.executable,'-I','-B',str(P/'check_source.py'),'--kind','sdk','--repo',str(source),'--expected-head',manifest['commit']],65);assert json.loads(guard)['result']=='PASS';verify_source()
 for name,filename,repo in [('bun','BUN-IMAGE.json','oven/bun'),('node','NODE-IMAGE.json','library/node')]:phase('pull-'+name,['docker','pull',repo+'@'+json.loads((P/filename).read_text())['selectedDigest']],120)
 phase('toolchain-assembly',['docker','build','--network=none','--pull=false','-t',prefix+'-tools','-f',str(P/'Dockerfile'),str(P)],90)
 text,_=phase('toolchain-image',['docker','image','inspect',prefix+'-tools','--format','{{.Id}}'],10);image=text.strip();assert re.fullmatch('sha256:[a-f0-9]{64}',image)
 toolcode="const c=require('node:child_process'),f=require('node:fs'),h=require('node:crypto');console.log(JSON.stringify({node:process.versions.node,bun:c.execFileSync('/usr/local/bin/bun',['--version'],{encoding:'utf8'}).trim(),bunSHA256:h.createHash('sha256').update(f.readFileSync('/usr/local/bin/bun')).digest('hex'),nodeSHA256:h.createHash('sha256').update(f.readFileSync('/usr/local/bin/node')).digest('hex')}));"
 container_phase('versions','none','2g',['/usr/local/bin/node','-e',toolcode],20);assert json.loads((out/'versions.log').read_text())==plan['expectedTools']
 container_phase('install','bridge','4g',['/usr/local/bin/bun','install','--frozen-lockfile','--ignore-scripts','--no-progress'],600,rw=True);verify_source()
 phase('inventory-installed-dependencies',[sys.executable,'-I','-B',str(P/'inventory_dependencies.py'),'capture',str(source),str(out),manifest['commit'],manifest['tree'],manifest['bunLockSHA256']],90)
 before=verify_dependencies('initial')
 for name in ['bootstrap.mjs','owning-preflight.mjs','PREFLIGHT-DEFINITION.json','ordinary-node-conditions.cjs','ordinary-cli-conditions-reporter.mjs','producer-bootstrap.mjs','capture-turbo-graph.mjs','output-custody.mjs','EXPECTED-GRAPH.json','REQUIRED-PRODUCER-EXPORTS.json','workspace-write-custody.mjs','TEST-RESOURCE-POLICY.json']:(out/name).write_bytes((P/name).read_bytes())
 container_phase('bootstrap','none','2g',['/usr/local/bin/node','/results/bootstrap.mjs'],30)
 container_phase('producer-owners','none','2g',['/usr/local/bin/node','/results/producer-bootstrap.mjs'],30)
 container_phase('workspace-before','none','2g',['/usr/local/bin/node','/results/workspace-write-custody.mjs','before'],90)
 container_phase('outputs-before','none','2g',['/usr/local/bin/node','/results/output-custody.mjs','before'],30)
 container_phase('normal-producer-graph','none','2g',['/usr/local/bin/node','/results/capture-turbo-graph.mjs'],60,rw=True)
 actual=json.loads((out/'TURBO-GRAPH.json').read_text());expected_graph=json.loads((P/'EXPECTED-GRAPH.json').read_text());expected=expected_graph['nodes'];seen=set();runnable=set();actual_edges={}
 for task in actual['tasks']:
  key=task['taskId'];assert key in expected and key not in seen;seen.add(key);node=expected[key]
  assert task['directory']==node['path'] and isinstance(task['dependencies'],list) and all(isinstance(x,str)for x in task['dependencies'])
  actual_edges[key]=task['dependencies']
  if node['script']:assert task['command']==node['script'];runnable.add(key)
  else:assert task.get('command')in(None,'','<NONEXISTENT>')
 assert seen==set(expected)and len(seen)==7 and len(runnable)==6
 assert {(key,dep)for key,deps in actual_edges.items()for dep in deps}=={(e['from'],e['to'])for e in expected_graph['edges']}
 (out/'TURBO-GRAPH-ADMISSION.json').write_text(json.dumps({'sourceCommit':manifest['commit'],'nodes':7,'edges':15,'runnable':6,'actualGraphSHA256':sha(out/'TURBO-GRAPH.json')},indent=2)+'\n')
 verify_source();verify_dependencies('after-graph')
 phase('host-memory-admission',[sys.executable,'-I','-B',str(P/'host-memory-admission.py'),str(out/'HOST-MEMORY.json')],30)
 producer_failure=container_phase('normal-producers','none','8g',expected_graph['normalCommand'],600,rw=True,test_family=True,node_old_space_mib=4096)
 verify_source();verify_dependencies('after-producer')
 assert producer_failure is None,'Normal producer entry failed; actual exit retained, no test or qualification'
 normal_log=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',(out/'normal-producers.log').read_text())
 assert re.findall(r'Tasks:\s+(\d+) successful,\s+(\d+) total',normal_log)[-1:]==[('6','6')]
 assert re.findall(r'Cached:\s+(\d+) cached,\s+(\d+) total',normal_log)[-1:]==[('0','6')]
 (out/'NORMAL-TASK-SUMMARY.json').write_text(json.dumps({'successful':6,'total':6,'cached':0,'sourceCommit':manifest['commit'],'logSHA256':sha(out/'normal-producers.log')},indent=2)+'\n')
 container_phase('outputs-after','none','2g',['/usr/local/bin/node','/results/output-custody.mjs','after'],90)
 verify_source();verify_dependencies('after-outputs')
 container_phase('workspace-after-producer','none','2g',['/usr/local/bin/node','/results/workspace-write-custody.mjs','verify'],90)
 # Observe all three ordinary whole-file CLI commands after fresh normal producer outputs.
 for group in plan['groups']:
  fresh_module_cache('module-cache-'+group['name'])
  command=['/usr/local/bin/node',group['runner'],'run',group['relative'],'--config',group['config'],'--configLoader','runner','--pool','forks','--maxWorkers','1','--maxConcurrency','1','--no-file-parallelism','--no-cache','--fsModuleCachePath','/results/module-cache-'+group['name'],'--reporter=json','--reporter=/results/ordinary-cli-conditions-reporter.mjs','--outputFile=/results/'+group['report']]
  failure=container_phase(group['name'],'none','2g',command,group['phaseSeconds'],test_family=True,cwd=group['cwd'],node_old_space_mib=1536)
  observe_ordinary(group,failure,command);verify_source()
 # This additional custom probe cannotprevent the ordinaryworkerobservations above.
 for cache_name in ['module-cache-owning-preflight','preflight-cache-assistant','preflight-cache-openai']:fresh_module_cache(cache_name)
 post_failure=container_phase('owning-preflight','none','2g',['/usr/local/bin/node','/results/owning-preflight.mjs'],90,test_family=True);verify_source()
 post={'phase':'owning-preflight','position':'AFTER_ALL_ORDINARY_CLI_OBSERVATIONS','exit':post_failure.code if post_failure else 0,'logSHA256':sha(out/'owning-preflight.log'),'reportPresent':(out/'OWNING-PREFLIGHT.json').is_file(),'qualification':False}
 if post_failure is None:
  observed=json.loads((out/'OWNING-PREFLIGHT.json').read_text());definition=json.loads((P/'PREFLIGHT-DEFINITION.json').read_text())
  assert observed['testsStarted']is False and len(observed['records'])==len(definition['projects'])==2
  for record,wanted in zip(observed['records'],definition['projects']):
   assert record['name']==wanted['name']and record['closed']is True and len(record['imports'])==len(wanted['edges'])
   assert all(row['requiredValueIdentityChecked']is True for row in record['imports'])
 (out/'POST-CLI-PREFLIGHT-OBSERVATION.json').write_text(json.dumps(post,indent=2)+'\n')
 container_phase('outputs-final','none','2g',['/usr/local/bin/node','/results/output-custody.mjs','final'],90)
 container_phase('workspace-final','none','2g',['/usr/local/bin/node','/results/workspace-write-custody.mjs','verify'],90)
 verify_source()
 after=verify_dependencies('final');assert before==after
 assert set(family_results)=={x['file']for x in plan['groups']}
 status='FAILED'if post_failure or any(x['ordinaryCLIExit']!=0 or x['reportErrors']or x['exactNamesMatch']is not True or x['actualRegistered']!=x['expectedSourceRegistrations']or x['actualPassed']!=x['expectedSourceRegistrations']or any(a['status']!='passed'for a in x['assertions'])or x['actualFailed']!=0 or x['actualPending']!=0 or x['actualTodo']!=0 or x['conditionObservationGap'] for x in family_results.values())else'QUALIFIED_SELECTED_WHOLE_FILES'

except BaseException as exc:run_error=type(exc).__name__+': '+str(exc)
finally:
 for index,item in enumerate(owned):
  try:cleanup_container(item,'cleanup-'+str(index))
  except ResourcePolicyError:pass
  except BaseException as exc:cleanup_errors.append({'cid':item['cid'],'error':str(exc)})
 resource_errors=[{'cid':item['cid'],**error} for item in owned for error in item.get('resourcePolicyFailures',[])]
 result={'state':'CLEANUP_FAILED' if cleanup_errors else 'RESOURCE_POLICY_FAILED' if resource_errors else status,'error':run_error,'phases':records,'containers':owned,'cleanupErrors':cleanup_errors,'resourcePolicyErrors':resource_errors,'families':family_results,'seconds':time.monotonic()-start,'sourceCommit':manifest['commit'],'sourceTree':manifest['tree'],'claim':'Selected113wholefile qualification only after normal6producer cold build, actual7node15edge graph, fresh output ownership, ordinaryCLI exactnames/counts/pass, value identity and final source/dependency/process/container closure. Scriptedmodels+loopbackonly; no semantictypes/liveprovider/runtime/device/financial acceptance.','diagnosticOnly':False,'qualificationIssued':status=='QUALIFIED_SELECTED_WHOLE_FILES' and not run_error and not cleanup_errors and not resource_errors,'customValuePreflightAfterAllCLI':True,'normalTypes':False,'entireCompoundPackageScriptsQualified':False,'broadSDKBuild':False,'liveModelProviderVoiceRuntimeDeviceFinancialAcceptance':False}
 (out/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
raise SystemExit(0 if status=='QUALIFIED_SELECTED_WHOLE_FILES' and not run_error and not cleanup_errors and not resource_errors else 1)
