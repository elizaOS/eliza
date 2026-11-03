"""Finite hosted normal API compiler qualifier; source-only until exact Root GO."""
import hashlib,json,os,pathlib,re,selectors,signal,shutil,subprocess,sys,time,importlib.util
P=pathlib.Path(__file__).resolve().parent
assert len(sys.argv)==3
source=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
plan=json.loads((P/'PLAN.json').read_text());manifest=json.loads((P/'SOURCE-MANIFEST.json').read_text());policy=json.loads((P/'NORMAL-API-POLICY.json').read_text());resource_policy={'defaultTest':{'nodeOldSpaceMiB':1536}}
for name,want in json.loads((P/'SEAL.json').read_text())['files'].items():assert sha(P/name)==want,name
observer_spec=importlib.util.spec_from_file_location('qualified_native_memory',P/'native_memory_observer.py');observer_module=importlib.util.module_from_spec(observer_spec);observer_spec.loader.exec_module(observer_module)
go_path=pathlib.Path(os.environ['ROOT_GO_JSON']).resolve();go=json.loads(go_path.read_text())
assert go['action']=='ONE_EXACT_QUALIFICATION_RUN'and go['recipe']=='normal-api-owning-typecheck'and go['mode']=='qualify'
assert go['allowHostedFrozenLockSetup']is True and go['allowNormalOwnedWorkspaceProducers']is True
assert go.get('allowNativeCompilerMeasurement') is True and go.get('measurementOnly') is True,'Separate native measurement admission required'
assert go.get('allowNativeSoftMemoryBudgetActuation') is True and go.get('nativeBudgetStage')=='api-normal-tsc' and go.get('nativeResourceKey')=='GOMEMLIMIT'
assert go.get('nativeGoSoftMemoryLimitBytes')==6442450944 and go.get('nativeGoSoftMemoryLimitEnv')=='6GiB','Explicit resource-experiment admission required'
assert go.get('allowHostedUnusedAndroidCleanup',False)is False
assert go['workflowCommit']==os.environ['GITHUB_SHA']==os.environ['EXPECTED_WORKFLOW_SHA']
assert go['sourceCommit']==manifest['commit']and go['sourceTree']==manifest['tree']
assert go['operatorSealSHA256']==sha(P/'SEAL.json')and go['normalApiPolicySHA256']==sha(P/'NORMAL-API-POLICY.json')
assert go['producerGraphSHA256']==sha(P/'EXPECTED-GRAPH.json')and go['sourceCustodySHA256']==sha(P/'SOURCE-CUSTODY.json')
assert go['compilerMemoryBytes']==8589934592 and go['compilerNodeOldSpaceMiB']==4096 and go['expectedRunnableTasks']==18
assert 0<go['issuedEpoch']<=time.time()<go['expiresEpoch']<=go['issuedEpoch']+1200
assert re.fullmatch('[a-f0-9]{32}',go['intentId'])and os.environ['GITHUB_RUN_ATTEMPT']=='1'
assert os.environ['GITHUB_REPOSITORY']=='elizaOS/eliza'and os.environ['GITHUB_EVENT_NAME']=='workflow_dispatch'and os.environ['RUNNER_ENVIRONMENT']=='github-hosted'
assert sys.platform=='linux'and os.uname().machine=='x86_64'and os.environ['ImageOS']=='ubuntu24'and os.environ['ImageVersion']in plan['hostEnvironment']['allowedImageVersions']
assert source==pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()/'source'and str(out)==go['output']and out.is_relative_to(pathlib.Path(os.environ['RUNNER_TEMP']).resolve())and not out.exists()
claim=json.loads((pathlib.Path(os.environ['RUNNER_TEMP'])/'speech-intent-claim.json').read_text());assert claim['actualRunId']==os.environ['GITHUB_RUN_ID']and claim['attempt']==1 and claim['rootGOsha256']==sha(go_path)
for key in ['intentId','workflowCommit','sourceCommit','sourceTree','operatorSealSHA256','normalApiPolicySHA256','producerGraphSHA256','sourceCustodySHA256','compilerMemoryBytes','compilerNodeOldSpaceMiB','expectedRunnableTasks','allowNormalOwnedWorkspaceProducers','allowNativeCompilerMeasurement','measurementOnly','allowNativeSoftMemoryBudgetActuation','nativeBudgetStage','nativeResourceKey','nativeGoSoftMemoryLimitBytes','nativeGoSoftMemoryLimitEnv','issuedEpoch','expiresEpoch']:assert claim[key]==go[key],key
import urllib.request
artifact_id=os.environ['CLAIM_ARTIFACT_ID'];assert artifact_id.isdigit()
request=urllib.request.Request('https://api.github.com/repos/elizaOS/eliza/actions/artifacts/'+artifact_id,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
with urllib.request.urlopen(request,timeout=20)as response:artifact=json.load(response)
assert artifact['name']=='speech-intent-'+go['intentId']and artifact['workflow_run']['id']==int(os.environ['GITHUB_RUN_ID'])and not artifact['expired']
with go_path.with_suffix('.consumed').open('x')as f:f.write('consumed')
out.mkdir()
for key in ['DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_CONFIG','DOCKER_API_VERSION']:assert not os.environ.get(key),'Inherited Docker override not admitted: '+key
assert os.environ.get('DOCKER_HOST','unix:///var/run/docker.sock')=='unix:///var/run/docker.sock'
assert os.environ.get('DOCKER_CONTEXT','default')=='default'
os.environ['DOCKER_HOST']='unix:///var/run/docker.sock';os.environ.pop('DOCKER_CONTEXT',None)
docker_config=out.parent/('normal-api-docker-config-'+os.environ['GITHUB_RUN_ID']);docker_config.mkdir();os.environ['DOCKER_CONFIG']=str(docker_config)
start=time.monotonic();free_start=shutil.disk_usage(out).free
records=[];owned=[];cleanup_errors=[];run_error=None;status='FAILED';normal_exit=None
runid=os.environ['GITHUB_RUN_ID'];prefix='normal-api-'+runid+'-1'

inspect_format='{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Error":{{json .State.Error}}}}'
resource_inspect_format='{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Error":{{json .State.Error}}},"Resources":{"memoryBytes":{{json .HostConfig.Memory}},"memorySwapBytes":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"pidsLimit":{{json .HostConfig.PidsLimit}},"cgroupParent":{{json .HostConfig.CgroupParent}},"nodeOptions":{{$nodeOptions := ""}}{{range .Config.Env}}{{if eq (printf "%.13s" .) "NODE_OPTIONS="}}{{$nodeOptions = .}}{{end}}{{end}}{{json $nodeOptions}}},"Ulimits":{{json .HostConfig.Ulimits}},"Hostname":{{json .Config.Hostname}},"GoMemoryLimitPresent":{{$go := false}}{{range .Config.Env}}{{if eq (printf "%.11s" .) "GOMEMLIMIT="}}{{$go = true}}{{end}}{{end}}{{json $go}},"NativeExperimentMounts":[{{$first := true}}{{range .Mounts}}{{if or (eq .Destination "/run/native-resource-experiment.json") (eq .Destination "/results/api-stage-recorder.cjs")}}{{if not $first}},{{end}}{{json .}}{{$first = false}}{{end}}{{end}}]}'
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

def phase(name,args,timeout,accepted=(0,),cleanup=False,observer=None):
 begin=time.monotonic();log=out/(name+'.log');written=0;proc=None;birth=None;empty=False;code=None;error=None;sel=None;observer_error=None
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
  proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
  first=identity(proc.pid);assert first and first['pgid']==proc.pid;birth=first['birth']
  os.set_blocking(proc.stdout.fileno(),False);sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ)
  with log.open('xb') as stream:
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
    if observer is not None:observer.poll()
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
  if observer is not None:
   try:observer.finish(code,error,empty)
   except BaseException as exc:observer_error=exc;error=(error or '')+'; observer '+type(exc).__name__+': '+str(exc)
  records.append({'phase':name,'seconds':time.monotonic()-begin,'exit':code,'acceptedExit':code in accepted,'error':error,'logBytes':written,'leaderBirth':birth,'ownedGroupEmpty':empty,'observerFDClosureVerified':None if observer is None else not observer._fds and not observer.close_errors})
  if proc and proc.stdout:proc.stdout.close()
  if not empty:raise RuntimeError('Unclosed owned process group')
  if observer_error is not None and sys.exc_info()[0] is None:raise RuntimeError('Native measurement finalization failed') from observer_error
 return log.read_text(),code

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
 if item.get('nativeResourceControlPath'):
  expected_mounts={'/run/native-resource-experiment.json':item['nativeResourceControlPath'],'/results/api-stage-recorder.cjs':str((P/'api-stage-recorder.cjs').resolve())}
  mounts=value.get('NativeExperimentMounts',[])
  if value.get('Hostname')!=item['cid'][:12] or value.get('GoMemoryLimitPresent') is not False or len(mounts)!=2 or {m['Destination']:m['Source']for m in mounts}!=expected_mounts or any(m['Type']!='bind' or m['RW'] for m in mounts):
   item.setdefault('resourcePolicyFailures',[]).append({'where':label,'error':'Native resource context/preload mount or hostname/container-env binding differs'})
   raise ResourcePolicyError('Actual protected native-resource mount/hostname/environment policy mismatch')
 if item.get('metadataFileSizeLimitBytes') is not None:
  expected_ulimits=[{'Name':'fsize','Hard':item['metadataFileSizeLimitBytes'],'Soft':item['metadataFileSizeLimitBytes']}]
  if value.get('Ulimits')!=expected_ulimits:
   item.setdefault('resourcePolicyFailures',[]).append({'where':label,'expectedUlimits':expected_ulimits,'actualUlimits':value.get('Ulimits')})
   raise ResourcePolicyError('Actual metadata Docker hard file-size policy mismatch')
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

def prepare_native_resource_context(item, value, control, control_inode):
    owners = json.loads((out / 'COMPILER-OWNERS.json').read_text())
    native = owners['nativeApiTsc']
    assert native['sha256'] == '4f2de678286401759b3fb4475bafe35b8f32b4b3a07d92642bbf37eadc9b34a4'
    assert native['goBuildInfo']['memoryControl'] == 'GOMEMLIMIT_SUPPORTED_SOFT_TARGET'
    selected = ['measurementOnly', 'allowNativeCompilerMeasurement', 'allowNativeSoftMemoryBudgetActuation',
                'nativeBudgetStage', 'nativeResourceKey', 'nativeGoSoftMemoryLimitBytes',
                'nativeGoSoftMemoryLimitEnv', 'intentId', 'issuedEpoch', 'expiresEpoch']
    root_context = {key: go[key] for key in selected}
    root_context['rootGOSHA256'] = sha(go_path)
    context = {
        'schema': 'NATIVE_API_ONLY_RESOURCE_EXPERIMENT_V1', 'root': root_context,
        'claim': {'rootGOsha256': claim['rootGOsha256'], 'intentId': claim['intentId'],
                  'actualRunId': claim['actualRunId'], 'attempt': claim['attempt']},
        'source': {'commit': manifest['commit'], 'tree': manifest['tree'],
                   'sealSHA256': sha(P / 'SEAL.json'), 'policySHA256': sha(P / 'NORMAL-API-POLICY.json')},
        'container': {'cid': item['cid'], 'name': item['name'], 'hostname': value['Hostname'],
                      'runId': runid, 'labels': {'run': value['Labels']['org.eliza.qualification-run'],
                                               'kind': value['Labels']['org.eliza.qualification-kind']},
                      'resources': item['resources']},
        'target': {'cwd': '/workspace/packages/cloud/api', 'stage': 'api-normal-tsc', 'argv': ['--noEmit'],
                   'wrapperFile': owners['apiTsc']['file'], 'wrapperSHA256': owners['apiTsc']['sha256'],
                   'native': native},
        'wrangler': {'file': owners['wrangler']['file'], 'sha256': owners['wrangler']['sha256']},
        'preloadSHA256': sha(P / 'api-stage-recorder.cjs'),
    }
    for key in ['measurementOnly','allowNativeCompilerMeasurement','allowNativeSoftMemoryBudgetActuation','nativeBudgetStage','nativeResourceKey','nativeGoSoftMemoryLimitBytes','nativeGoSoftMemoryLimitEnv']:
        context['claim'][key] = claim[key]
    data = (json.dumps(context, separators=(',', ':')) + '\n').encode()
    assert len(data) <= 8192
    fd = os.open(control, os.O_WRONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        assert (info.st_dev, info.st_ino) == control_inode and info.st_size == 0
        written = 0
        while written < len(data):
            count = os.write(fd, data[written:])
            assert count > 0
            written += count
        assert os.fstat(fd).st_size == len(data)
        os.fchmod(fd, 0o400)
    finally:
        os.close(fd)
    assert control.read_bytes() == data
    with (out / 'NATIVE-RESOURCE-CONTEXT.json').open('xb') as file:
        file.write(data)
    item['nativeResourceContextSHA256'] = hashlib.sha256(data).hexdigest()


def audit_native_resource_witness():
    effect_path = out / 'NATIVE-RESOURCE-APPLIED.json'
    context_path = out / 'NATIVE-RESOURCE-CONTEXT.json'
    if not effect_path.exists():
        return {'state': 'RESOURCE_EXPERIMENT_ONLY_NO_EFFECT_WITNESS', 'verified': False, 'typeAcceptance': 'NOT_ISSUED'}
    assert effect_path.stat().st_size <= 4096 and context_path.stat().st_size <= 8192
    effect = json.loads(effect_path.read_text())
    context = json.loads(context_path.read_text())
    assert effect['state'] == 'RESOURCE_EXPERIMENT_ONLY_SINGLE_KEY_APPLIED'
    assert effect['key'] == 'GOMEMLIMIT' and effect['value'] == '6GiB' and effect['bytes'] == 6442450944
    assert effect['oldState'] == 'UNSET' and effect['stage'] == 'api-normal-tsc'
    assert effect['rootGOSHA256'] == sha(go_path) and effect['intentId'] == go['intentId']
    assert effect['contextSHA256'] == sha(context_path)
    assert context['root']['rootGOSHA256'] == sha(go_path)
    assert context['source']['sealSHA256'] == sha(P / 'SEAL.json')
    assert context['source']['policySHA256'] == sha(P / 'NORMAL-API-POLICY.json')
    actual = [item for item in owned if item['name'] == prefix + '-normal-api-entry']
    assert len(actual) == 1 and effect['cid'] == actual[0]['cid']
    assert effect['nativeSHA256'] == context['target']['native']['sha256']
    assert effect['wrapperSHA256'] == context['target']['wrapperSHA256']
    events = [json.loads(line) for line in (out / 'API-STAGES.jsonl').read_text().splitlines()]
    starts = [row for row in events if row['stage'] == 'api-normal-tsc' and row['event'] == 'start']
    assert len(starts) == 1
    assert effect['pid'] == starts[0]['pid'] and effect['procBirthTicks'] == starts[0]['procBirthTicks']
    assert starts[0]['argv'] == ['--noEmit']
    processes = json.loads((out / 'MEMORY-PROCESS-SUMMARY.json').read_text())
    matching = []
    for row in processes['nativeBindings']:
        if row['nativeSHA256'] != effect['nativeSHA256']:
            continue
        same_pid = row['birth'] == effect['procBirthTicks'] and row['namespacePids'][-1] == effect['pid']
        child_rows = [child for child in processes['processes'] if child['hostPid'] == row['hostPid'] and child['birth'] == row['birth']]
        parent_rows = [parent for child in child_rows for parent in processes['processes']
                       if parent['hostPid'] == child['parentPid'] and parent['namespacePids'][-1] == effect['pid']
                       and parent['birth'] == effect['procBirthTicks'] and not parent['isExpectedNative']]
        child_fallback = row['relation'] == 'child-of-api-pid' and row['apiPidImageIsNative'] is False and bool(parent_rows)
        if same_pid or child_fallback:
            matching.append(row)
    return {'state': 'RESOURCE_EXPERIMENT_ONLY_SOURCE_BOUND_INITIAL_ENV_INHERITANCE',
            'verified': bool(matching), 'effectWitnessSHA256': sha(effect_path), 'contextSHA256': sha(context_path),
            'controlledKey': effect['key'], 'controlledValue': effect['value'], 'pid': effect['pid'],
            'procBirthTicks': effect['procBirthTicks'], 'nativeSHA256': effect['nativeSHA256'],
            'nativeBindingObserved': bool(matching),
            'directNativeEnvironmentRead': False, 'internalRuntimeLimitMeasured': False,
            'nativeRawExitCode': None, 'typeAcceptance': 'NOT_ISSUED'}


def container_phase(name,network,memory,command,timeout,rw=False,test_family=False,cwd="/workspace",node_old_space_mib=None):
 assert (name=="install" and network=="bridge" and rw) or (name in ("normal-api-graph","normal-api-entry") and network=="none" and rw) or (name not in ("install","normal-api-graph","normal-api-entry") and network=="none" and not rw)
 if node_old_space_mib is None:node_old_space_mib=resource_policy['defaultTest']['nodeOldSpaceMiB']
 assert memory in ('2g','4g','8g') and node_old_space_mib in (1536,4096)
 memory_bytes=int(memory[:-1])*1024**3
 resources={'memoryBytes':memory_bytes,'memorySwapBytes':memory_bytes,'nanoCpus':2000000000,'pidsLimit':256,'nodeOptions':'NODE_OPTIONS=--max-old-space-size='+str(node_old_space_mib),'cgroupParent':'system.slice' if name=='normal-api-entry' else ''}
 cname=prefix+'-'+name
 control=None;control_inode=None
 if name=='normal-api-entry':
  control_dir=out.parent/('native-resource-control-'+runid+'-'+go['intentId']);control_dir.mkdir(mode=0o700)
  control=control_dir/'context.json'
  with control.open('xb')as file:
   os.fchmod(file.fileno(),0o600);info=os.fstat(file.fileno());control_inode=(info.st_dev,info.st_ino)
 assert inspect_container(cname,name+'-absence') is None,'Preexisting container name; no mutation'
 args=['docker','create','--pull=never','--name',cname,'--label','org.eliza.qualification-run='+runid,'--label','org.eliza.qualification-kind=speech-retirement','--network',network,'--cpus','2','--memory',memory,'--memory-swap',memory,'--pids-limit','256','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,size=536870912','--mount','type=bind,src='+str(source)+',dst=/workspace'+('' if rw else ',readonly'),'--mount','type=bind,src='+str(out)+',dst=/results','--workdir',cwd,'--env','HOME=/tmp/home','--env','TMPDIR=/tmp','--env','CI=true','--env','NODE_ENV=test','--env',resources['nodeOptions'],'--env','ELIZA_VAULT_DISABLE_KEYCHAIN=1','--env','ELIZA_LIVE_TEST=0','--env','BUN_INSTALL_CACHE_DIR='+('/workspace/.cache/qualification-bun' if name=='install' else '/tmp/bun-cache'),'--env','BUN_CONFIG_NO_AUTO_INSTALL=true','--env','VITEST_FS_MODULE_CACHE_PATH=/results/fs-module-cache','--entrypoint',command[0],image,*command[1:]]
 if name not in ('install','versions'):
  # Canonical normal CI does not set the fixture-only NODE_ENV=test.
  env_index=args.index('NODE_ENV=test');assert args[env_index-1]=='--env';del args[env_index-1:env_index+1]
 if name=='normal-api-entry':
  # The metadata gate has already checked the effective system.slice ceiling.
  at=args.index('--entrypoint');args[at:at]=['--cgroup-parent','system.slice','--env','RUN_TURBO_CONCURRENCY=1','--env','RUN_TURBO_NO_INIT_CRASH_RETRY=1','--env','TURBO_TELEMETRY_DISABLED=1']
  at=args.index('--entrypoint');args[at:at]=['--mount','type=bind,src='+str(control)+',dst=/run/native-resource-experiment.json,readonly','--mount','type=bind,src='+str((P/'api-stage-recorder.cjs').resolve())+',dst=/results/api-stage-recorder.cjs,readonly']
  node_index=args.index(resources['nodeOptions']);resources['nodeOptions']+=' --require=/results/api-stage-recorder.cjs';args[node_index]=resources['nodeOptions']
 elif name=='normal-api-graph':
  at=args.index('--entrypoint');args[at:at]=['--env','RUN_TURBO_CONCURRENCY=1','--env','RUN_TURBO_NO_INIT_CRASH_RETRY=1','--env','TURBO_TELEMETRY_DISABLED=1']
  at=args.index('--entrypoint');args[at:at]=['--ulimit','fsize=8388608:8388608']
 # Register intent before the daemon can create anything. A lost CLI reply
 # is reconciled by exact name AND run labels, never removed by name alone.
 item={'cid':None,'name':cname,'createCompleted':False,'resources':resources};owned.append(item)
 if name=='normal-api-graph':item['metadataFileSizeLimitBytes']=8388608
 if control is not None:item['nativeResourceControlPath']=str(control)
 text,_=phase(name+'-create',args,20);cid=text.strip();assert re.fullmatch('[a-f0-9]{64}',cid)
 item['cid']=cid;item['createCompleted']=True
 value=inspect_container(cid,name+'-identity',resources=True);check_container(value,item);check_resources(value,item,name+'-identity')
 if name=='normal-api-entry':prepare_native_resource_context(item,value,control,control_inode)
 failure=None
 observer=observer_module.NativeMemoryObserver(item,value,source,out,min(time.monotonic()+timeout,time.monotonic()+go['expiresEpoch']-time.time())) if name=='normal-api-entry' else None
 try:phase(name,['docker','start','--attach',cid],timeout,observer=observer)
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

def verify_dependencies(final=False):
 receipt=out/'DEPENDENCY-INVENTORY.json';d=json.loads(receipt.read_text())
 assert d['sourceCommit']==manifest['commit'] and d['sourceTree']==manifest['tree']
 assert d['bunLockSHA256']==manifest['bunLockSHA256'] and d['ignoreScripts'] is True and d['nativeHooksExecuted'] is False
 assert d['files']>0 and d['sourceRoot']==str(source) and d['platform']=='linux-x64'
 assert sha(out/'dependency-files.jsonl')==d['inventorySHA256']
 phase('verify-installed-dependencies'+('-final' if final else ''),[sys.executable,'-I','-B',str(P/'inventory_dependencies.py'),'verify',str(source),str(out),manifest['commit'],manifest['tree'],manifest['bunLockSHA256']],90)
 return {'receiptSHA256':sha(receipt),'inventorySHA256':d['inventorySHA256'],'fileCount':d['files'],'normalNativeLifecycle':False}

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
 for name,want in custody['owningProducerTreePins'].items():assert git('rev-parse','HEAD:'+name)==want
 for name,want in custody['extraNormalHelperGitBlobPins'].items():assert git('rev-parse','HEAD:'+name)==want
 for directory in [source,*[source/x for x in custody['owningProducerTreePins']]]:
  for name in ['.env','.env.local','.env.test','.env.test.local','.env.development','.env.development.local','.env.production','.env.production.local','.dev.vars','.dev.vars.production']:
   assert not (directory/name).exists() and not (directory/name).is_symlink(), 'Credential-bearing environment file not admitted'


try:
 assert free_start>=plan['resourceBounds']['minimumStartFreeBytes']
 (out/'runner.json').write_text(json.dumps({'ImageOS':os.environ['ImageOS'],'ImageVersion':os.environ['ImageVersion'],'runId':runid,'attempt':1,'freeStartBytes':free_start},indent=2)+'\n')
 text,_=phase('docker-version',['docker','version','--format','{{.Server.Version}}'],10);assert text.strip()==plan['reviewedRunner']['dockerServer']
 text,_=phase('docker-platform',['docker','info','--format','{{.OSType}}/{{.Architecture}}'],10);assert text.strip()=='linux/x86_64'
 phase('known-incident-source-guard',[sys.executable,'-I','-B',str(P/'check_source.py'),'--kind','sdk','--repo',str(source),'--expected-head',manifest['commit']],65);verify_source()
 for label,filename,repo in [('bun','BUN-IMAGE.json','oven/bun'),('node','NODE-IMAGE.json','library/node')]:phase('pull-'+label,['docker','pull',repo+'@'+json.loads((P/filename).read_text())['selectedDigest']],120)
 phase('toolchain-assembly',['docker','build','--network=none','--pull=false','-t',prefix+'-tools','-f',str(P/'Dockerfile'),str(P)],90)
 text,_=phase('toolchain-image',['docker','image','inspect',prefix+'-tools','--format','{{.Id}}'],10);image=text.strip();assert re.fullmatch('sha256:[a-f0-9]{64}',image)
 toolcode="const c=require('node:child_process'),f=require('node:fs'),h=require('node:crypto');console.log(JSON.stringify({node:process.versions.node,bun:c.execFileSync('/usr/local/bin/bun',['--version'],{encoding:'utf8'}).trim(),bunSHA256:h.createHash('sha256').update(f.readFileSync('/usr/local/bin/bun')).digest('hex'),nodeSHA256:h.createHash('sha256').update(f.readFileSync('/usr/local/bin/node')).digest('hex')}));"
 container_phase('versions','none','2g',['/usr/local/bin/node','-e',toolcode],20);assert json.loads((out/'versions.log').read_text())==plan['expectedTools']
 container_phase('install','bridge','4g',['/usr/local/bin/bun','install','--frozen-lockfile','--ignore-scripts','--no-progress'],600,rw=True);verify_source()
 phase('inventory-installed-dependencies',[sys.executable,'-I','-B',str(P/'inventory_dependencies.py'),'capture',str(source),str(out),manifest['commit'],manifest['tree'],manifest['bunLockSHA256']],90)
 dependency_admission=verify_dependencies();(out/'DEPENDENCY-ADMISSION.json').write_text(json.dumps(dependency_admission,indent=2)+'\n')
 for name in ['compiler-bootstrap.mjs','api-stage-recorder.cjs','capture-turbo-graph.mjs','output-custody.mjs','go-buildinfo.mjs']:(out/name).write_bytes((P/name).read_bytes())
 (out/'EXPECTED-GRAPH.json').write_bytes((P/'EXPECTED-GRAPH.json').read_bytes())
 container_phase('compiler-owners','none','2g',['/usr/local/bin/node','/results/compiler-bootstrap.mjs'],30);verify_source()
 container_phase('normal-api-graph','none','2g',['/usr/local/bin/node','/results/capture-turbo-graph.mjs'],60,rw=True)
 actual=json.loads((out/'TURBO-GRAPH.json').read_text());expected_graph=json.loads((P/'EXPECTED-GRAPH.json').read_text());expected=expected_graph['nodes'];seen=set();runnable=set();actual_edges={}
 for task in actual['tasks']:
  key=task['taskId'];assert key in expected and key not in seen;seen.add(key);node=expected[key]
  assert task['directory']==node['path']and isinstance(task['dependencies'],list)and all(isinstance(x,str)for x in task['dependencies'])
  actual_edges[key]=task['dependencies']
  if node['script']:
   assert task['command']==node['script'];runnable.add(key)
  else:assert task.get('command')in(None,'','<NONEXISTENT>')
 assert runnable=={key for key,node in expected.items()if node['script']}and len(runnable)==18
 assert all(dep in seen for deps in actual_edges.values()for dep in deps),'Incomplete actual Turbo dependency graph'
 expected_edges={key:[]for key in expected}
 for edge in expected_graph['edges']:expected_edges[edge['from']].append(edge['to'])
 def producer_ancestors(edges,key,trail=()):
  assert key not in trail,'Task dependency cycle';answer=set()
  for dep in edges[key]:
   if expected[dep]['script']:answer.add(dep)
   answer.update(producer_ancestors(edges,dep,(*trail,key)))
  return answer
 normalized={}
 for key in sorted(runnable):
  wanted=producer_ancestors(expected_edges,key);observed=producer_ancestors(actual_edges,key);assert wanted==observed,'Actual canonical producer order differs: '+key
  normalized[key]=sorted(observed)
 (out/'TURBO-GRAPH-ADMISSION.json').write_text(json.dumps({'exactRunnableScripts':18,'actualTaskCount':len(seen),'normalization':'Compare transitive executable prerequisites through any listed no-script transit nodes; no missing observed dependency IDs or unknown tasks allowed.','producerAncestors':normalized},indent=2)+'\n')
 verify_source();container_phase('outputs-before','none','2g',['/usr/local/bin/node','/results/output-custody.mjs','before'],30)
 phase('host-memory-admission',[sys.executable,'-I','-B',str(P/'host-memory-admission.py'),str(out/'HOST-MEMORY.json')],30)
 normal_exit=container_phase('normal-api-entry','none','8g',policy['normalCommand'],900,rw=True,test_family=True,node_old_space_mib=4096)
 verify_source();verify_dependencies(final=True)
 if normal_exit is None:
  assert not(out/'STAGE-RECORDER-ERROR.log').exists(),'Stage recorder metadata failed'
  events=[json.loads(line)for line in(out/'API-STAGES.jsonl').read_text().splitlines()]
  tsc_starts=[x for x in events if x['stage']=='api-normal-tsc' and x['event']=='start']
  tsc_ends=[x for x in events if x['stage']=='api-normal-tsc' and x['event']=='exit']
  assert len(tsc_starts)==1 and tsc_starts[0]['argv']==['--noEmit']
  assert tsc_starts[0]['executableSHA256']==json.loads((out/'COMPILER-OWNERS.json').read_text())['apiTsc']['sha256']
  for stage in ['api-router-contract','api-worker-dry-run']:
   rows=[x for x in events if x['stage']==stage];starts=[x for x in rows if x['event']=='start'];ends=[x for x in rows if x['event']=='exit'];assert starts and len(starts)==len(ends)and all(x['code']==0 for x in ends)
   assert sorted(x['pid']for x in starts)==sorted(x['pid']for x in ends)
  assert all(x['nodeOptions']=='--max-old-space-size=4096 --require=/results/api-stage-recorder.cjs' for x in events if x['event']=='start')
  if tsc_ends:assert len(tsc_ends)==1 and tsc_ends[0]['pid']==tsc_starts[0]['pid'] and tsc_ends[0]['code']==0
  observation=json.loads((out/'MEMORY-FINALIZATION.json').read_text())
  resource_evidence=audit_native_resource_witness();assert resource_evidence['verified'],'Resource effect consumer not bound'
  stage_evidence={'state':'RESOURCE_EXPERIMENT_ONLY_NO_TYPE_ACCEPTANCE','normalPipelineExit':0,'compilerStart':tsc_starts[0],'observedNodeExit':tsc_ends or None,'nativeBindingObserved':observation['nativeBindingObserved'],'missingNodeExitIsNotTypeScriptError':not bool(tsc_ends),'nativeRawExitCode':None,'resourceExperimentEvidence':resource_evidence,'nextStageAndPipelineEvidence':'Router and worker actual Node exits0 plus canonical pipeline0; compiler raw native exit remains unobserved if execve replaced Node','typeAcceptance':'NOT_ISSUED_BY_MEASUREMENT_CONTROLLER'}
  stage_bytes=(json.dumps(stage_evidence,indent=2)+'\n').encode();assert len(stage_bytes)<=16384
  with(out/'API-STAGE-EVIDENCE.json').open('xb')as file:file.write(stage_bytes)
  container_phase('outputs-after','none','2g',['/usr/local/bin/node','/results/output-custody.mjs','after'],90)
  entry_records=[row for row in records if row['phase']=='normal-api-entry'];assert len(entry_records)==1
  entry_record=entry_records[0]
  measurement_bound=observation['collectionContractSatisfied'] and observation['nativeBindingObserved'] and observation['scopeDeviceInode'] is not None and observation['ticks']>0 and observation['ownedCLIGroupEmpty'] and observation['phaseError'] is None and entry_record['exit']==0 and entry_record['error'] is None and entry_record['ownedGroupEmpty'] is True and entry_record.get('observerFDClosureVerified') is True
  status='RESOURCE_EXPERIMENT_ONLY_PIPELINE_ZERO_TYPES_NOT_ISSUED' if measurement_bound else 'RESOURCE_EXPERIMENT_ONLY_PIPELINE_ZERO_OBSERVATION_INCOMPLETE'
 else:status='RESOURCE_EXPERIMENT_ONLY_PIPELINE_NONZERO_NATIVE_STAGE_MAY_BE_UNFINISHED'

except BaseException as exc:run_error=type(exc).__name__+': '+str(exc)
finally:
 for index,item in enumerate(owned):
  try:cleanup_container(item,'cleanup-'+str(index))
  except ResourcePolicyError:pass
  except BaseException as exc:cleanup_errors.append({'cid':item['cid'],'error':str(exc)})
 try:resource_experiment_evidence=audit_native_resource_witness()
 except BaseException as exc:resource_experiment_evidence={'state':'RESOURCE_EXPERIMENT_ONLY_WITNESS_INVALID','verified':False,'error':type(exc).__name__+': '+str(exc),'typeAcceptance':'NOT_ISSUED'}
 resource_result_addition={'purpose':'RESOURCE_EXPERIMENT_ONLY','resourceExperimentOnly':True,'resourceExperimentEvidence':resource_experiment_evidence}
 if len(json.dumps(resource_result_addition,indent=2).encode())+32>4096:
  resource_experiment_evidence={'state':'RESOURCE_EXPERIMENT_ONLY_RESULT_EVIDENCE_CAP_FAILED','verified':False,'typeAcceptance':'NOT_ISSUED'}
  run_error=(run_error or '')+'; resource-result metadata budget exceeded'
 assert len(json.dumps({'purpose':'RESOURCE_EXPERIMENT_ONLY','resourceExperimentOnly':True,'resourceExperimentEvidence':resource_experiment_evidence},indent=2).encode())+32<=4096
 resource_errors=[{'cid':item['cid'],**x}for item in owned for x in item.get('resourcePolicyFailures',[])]
 result_containers=[{key:value for key,value in item.items()if key not in ['nativeResourceControlPath','nativeResourceContextSHA256']}for item in owned]
 result={'state':'CLEANUP_FAILED'if cleanup_errors else'RESOURCE_POLICY_FAILED'if resource_errors else status,'error':run_error,'normalPipelineExit':next((x['exit']for x in records if x['phase']=='normal-api-entry'),None),'phases':records,'containers':result_containers,'cleanupErrors':cleanup_errors,'resourcePolicyErrors':resource_errors,'seconds':time.monotonic()-start,'sourceCommit':manifest['commit'],'sourceTree':manifest['tree'],'normalApiPolicySHA256':sha(P/'NORMAL-API-POLICY.json'),'compilerOnlyPASS':False,'purpose':'RESOURCE_EXPERIMENT_ONLY','measurementOnly':True,'resourceExperimentOnly':True,'resourceExperimentEvidence':resource_experiment_evidence,'typeAcceptance':'NOT_ISSUED_BY_MEASUREMENT_CONTROLLER','CoreNoCheckIsNotCoreTypecheckPASS':True,'APITypeScript6Compatibility':'NOT_ADMITTED','liveProviderFinancialNativeAcceptance':False}
 (out/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
raise SystemExit(0 if status=='RESOURCE_EXPERIMENT_ONLY_PIPELINE_ZERO_TYPES_NOT_ISSUED'and not run_error and not cleanup_errors and not resource_errors else 1)
