"""Paired-source normal-family controller DRAFT. Source preparation only.
The first admission gate is deliberately false in this packet. No GO exists.
Phase/PGID/CID custody is derived from the existing normal-v8 supervisor.
"""
import collections,hashlib,json,os,pathlib,re,selectors,signal,shutil,stat,subprocess,sys,time,urllib.request,xml.etree.ElementTree as ET
P=pathlib.Path(__file__).resolve().parent
plan=json.loads((P/'PLAN.json').read_text())
# Fail before any process, output creation, claim, install, producer or test.
assert plan['state']=='FROZEN_REVIEWED_READY', 'DRAFT: oracle/preflight/workflow/seal/source/resource review incomplete; no execution authorized'
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
manifest=json.loads((P/'SOURCE-MANIFEST.json').read_text())
oracle=json.loads((P/'ORACLES.json').read_text())
admission=json.loads((P/'SOURCE-ADMISSION.json').read_text())
offline_guard=json.loads((P/'SDK-PUBLISHER-SOURCE-GUARD.json').read_text())
assert admission['SDK']['commit']==plan['candidates']['SDK']['commit']==offline_guard['head']
assert offline_guard['result']=='PASS' and offline_guard['ancestryComplete'] is True and not offline_guard['trackedChangedFiles']
assert admission['SDK']['localPublisherGuardSHA256']==sha(P/'SDK-PUBLISHER-SOURCE-GUARD.json')
assert admission['SDK']['remoteLiteralReviewSHA256']==sha(P/'R7-REMOTE-LITERAL-PAIR-REVIEW.json')
assert admission['RootDisposition']['sha256']==sha(P/'ROOT-SOURCE-ADMISSION-DISPOSITION.json')

assert oracle['state']=='REVIEWED_SOURCE_ORACLES_WITH_MANDATORY_RUNTIME_CENSUS'
assert len(oracle['files'])==len(plan['groups'])==12
assert {r['repository']+':'+r['file'] for r in plan['groups']}==set(oracle['files'])
for name,digest in json.loads((P/'SEAL.json').read_text())['files'].items():assert sha(P/name)==digest,name
for group in plan['groups']:
 assert group['name'] in oracle['groups'] and oracle['groups'][group['name']]['repository']==group['repository'] and oracle['groups'][group['name']]['file']==group['file']
 if group['repository']=='SDK':
  package='/'.join(group['file'].split('/')[:2]);assert package in ['packages/app','packages/host','packages/ui','packages/voice']
  relative=group['file'][len(package)+1:];config='vitest.host.config.ts'if package=='packages/app'else'vitest.config.ts'
  expected=['/usr/local/bin/node','/workspace/sdk/packages/scripts/run-vitest.ts','run',relative,'--config',config,'--configLoader','runner','--pool','forks','--maxWorkers','1','--maxConcurrency','1','--no-file-parallelism','--no-cache','--fsModuleCachePath','/results/module-cache-'+group['name'],'--reporter=json','--outputFile=/results/'+group['report'],'--includeTaskLocation','--reporter=/operator/normal-vitest-case-observer.mjs']
  assert group['cwd']=='/workspace/sdk/'+package
 else:
  expected=['/usr/local/bin/node','--test','--test-concurrency=1','--test-reporter=junit','--test-reporter=/operator/normal-node-case-observer.mjs','--test-reporter-destination=/results/'+group['report'],'--test-reporter-destination=stdout',group['file']]
  assert group['cwd']=='/workspace/alpha'
 assert group['command']==expected, 'Only the exact normal full-file commands are admitted'
go_path=pathlib.Path(os.environ['ROOT_GO_JSON']).resolve();go=json.loads(go_path.read_text())
assert go['action']=='ONE_EXACT_QUALIFICATION_RUN' and go['recipe']=='paired-voice-terminal-normal-v2' and go['mode']=='qualify'
assert go['sources']==plan['candidates'] and go['allowHostedFrozenLockSetup'] is True
assert go['allowPinnedGitBootstrapBeforeAlphaAncestry'] is True
for key,filename in [('operatorSealSHA256','SEAL.json'),('oracleSHA256','ORACLES.json'),('sourceManifestSHA256','SOURCE-MANIFEST.json'),('resourcePolicySHA256','TEST-RESOURCE-POLICY.json'),('toolchainSHA256','TOOLCHAIN.json'),('hostCohortsSHA256','HOST-COHORTS.json')]:assert go[key]==sha(P/filename)
assert re.fullmatch('[a-f0-9]{32}',go['intentId'])
assert 0<go['issuedEpoch']<=time.time()<go['expiresEpoch']<=go['issuedEpoch']+1200
assert go['workflowCommit']==os.environ['GITHUB_SHA']==os.environ['EXPECTED_WORKFLOW_SHA']
assert os.environ['GITHUB_RUN_ATTEMPT']=='1' and os.environ['RUNNER_ENVIRONMENT']=='github-hosted'
assert os.environ['GITHUB_REPOSITORY']=='elizaOS/eliza' and os.environ['GITHUB_EVENT_NAME']=='workflow_dispatch'
assert sys.platform=='linux' and os.uname().machine=='x86_64' and (3,12)<=sys.version_info[:2]<(3,16)
host_policy=json.loads((P/'HOST-COHORTS.json').read_text())
runner_metadata={}
for key,spec in host_policy['metadataFields'].items():
 value=os.environ.get(spec['environment']);runner_metadata[key]=value if value is None or len(value)<=spec['maxChars'] else {'overBound':True,'length':len(value)}
metadata_line=json.dumps({'state':'OBSERVED_RUNNER_METADATA_NOT_ADMISSION','fields':runner_metadata},separators=(',',':'));assert len(metadata_line.encode())<=4096
print(metadata_line,flush=True)
assert os.environ.get('ImageOS')==host_policy['ImageOS'] and os.environ.get('ImageVersion')in host_policy['allowedImageVersions']
assert 'ALPHA_PRIVATE_CARTESIA_TEST_CASE' not in os.environ
workspace=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()
roots={'SDK':workspace/'source-sdk','Alpha':workspace/'source-alpha'}
assert len(sys.argv)==2
out=pathlib.Path(sys.argv[1]).resolve();assert out==pathlib.Path(os.environ['RUNNER_TEMP']).resolve()/'paired-voice-results' and str(out)==go['output'] and not out.exists()
claim_path=pathlib.Path(os.environ['RUNNER_TEMP'])/'speech-intent-claim.json';claim=json.loads(claim_path.read_text())
assert claim['rootGOsha256']==sha(go_path) and claim['actualRunId']==os.environ['GITHUB_RUN_ID'] and claim['attempt']==1
assert isinstance(claim['diskAvailableBytesAtClaim'],int) and claim['diskAvailableBytesAtClaim']>=17179869184
for key in ['intentId','sources','workflowCommit','operatorSealSHA256','oracleSHA256','sourceManifestSHA256','resourcePolicySHA256','toolchainSHA256','hostCohortsSHA256','issuedEpoch','expiresEpoch','output','recipe','mode','allowHostedFrozenLockSetup','allowPinnedGitBootstrapBeforeAlphaAncestry']:assert claim[key]==go[key]
artifact_id=os.environ['CLAIM_ARTIFACT_ID'];assert artifact_id.isdigit()
request=urllib.request.Request('https://api.github.com/repos/elizaOS/eliza/actions/artifacts/'+artifact_id,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
with urllib.request.urlopen(request,timeout=20) as response:artifact=json.load(response)
assert artifact['name']=='speech-intent-'+go['intentId'] and artifact['workflow_run']['id']==int(os.environ['GITHUB_RUN_ID']) and artifact['expired'] is False
assert shutil.disk_usage(out.parent).free>=17179869184
with go_path.with_suffix('.consumed').open('x') as f:f.write('consumed')
out.mkdir()
seal=json.loads((P/'SEAL.json').read_text())['files']
required={'run.py','PLAN.json','SOURCE-MANIFEST.json','ORACLES.json','TEST-RESOURCE-POLICY.json','TOOLCHAIN.json','Dockerfile','verify-host.py','check_source.py','POLICY.json','HOST-COHORTS.json','SOURCE-ADMISSION.json','SDK-PUBLISHER-SOURCE-GUARD.json','R7-REMOTE-LITERAL-PAIR-REVIEW.json','ROOT-SOURCE-ADMISSION-DISPOSITION.json'}|set(plan['containerHelperFiles'])
for label in roots:
 required|={f'dependency-census/{label}/inventory_dependencies.py',f'dependency-census/{label}/WORKSPACE-DEPENDENCY-ROOTS.json'}
assert required.issubset(seal)
projection=out/'projection';records=[];owned=[];family_results={};cleanup_errors=[];run_error=None;status='FAILED';start=time.monotonic();free_start=claim['diskAvailableBytesAtClaim'];assert free_start-shutil.disk_usage(out).free<=12884901888
runid=os.environ['GITHUB_RUN_ID'];assert runid.isdigit();prefix='speech-retirement-'+runid+'-1-paired-voice'
resource_policy={'defaultTest':{'nodeOldSpaceMiB':1536}}
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
resource_inspect_format='{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"Error":{{json .State.Error}}},"Resources":{"memoryBytes":{{json .HostConfig.Memory}},"memorySwapBytes":{{json .HostConfig.MemorySwap}},"nanoCpus":{{json .HostConfig.NanoCpus}},"pidsLimit":{{json .HostConfig.PidsLimit}},"nodeOptions":{{$nodeOptions := ""}}{{range .Config.Env}}{{if eq (printf "%.13s" .) "NODE_OPTIONS="}}{{$nodeOptions = .}}{{end}}{{end}}{{json $nodeOptions}}}}'
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

def container_phase(name,network,memory,command,timeout,repository="SDK",test_family=False,cwd="/workspace/sdk",node_old_space_mib=None):
 assert repository in roots
 install=name in ("install-sdk","install-alpha");ancestry=name=='alpha-ancestry'
 assert ((install or ancestry) and network=="bridge") or (not install and not ancestry and network=="none")
 assert not install or repository==("SDK" if name=="install-sdk" else "Alpha")
 if node_old_space_mib is None:node_old_space_mib=resource_policy['defaultTest']['nodeOldSpaceMiB']
 assert memory in ('2g','4g') and node_old_space_mib in (1024,1536)
 memory_bytes=int(memory[:-1])*1024**3
 resources={'memoryBytes':memory_bytes,'memorySwapBytes':memory_bytes,'nanoCpus':2000000000,'pidsLimit':256,'nodeOptions':'NODE_OPTIONS=--max-old-space-size='+str(node_old_space_mib)}
 cname=prefix+'-'+name
 assert inspect_container(cname,name+'-absence') is None,'Preexisting container name; no mutation'
 args=['docker','create','--pull=never','--name',cname,'--label','org.eliza.qualification-run='+runid,'--label','org.eliza.qualification-kind=speech-retirement','--network',network,'--cpus','2','--memory',memory,'--memory-swap',memory,'--pids-limit','256','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,size=536870912']
 for label,destination in [('SDK','/workspace/sdk'),('Alpha','/workspace/alpha')]:
  args+=['--mount','type=bind,src='+str(roots[label])+',dst='+destination+('' if install and repository==label else ',readonly')]
 if ancestry:
  metadata=roots['Alpha']/'.git';info=metadata.lstat();assert stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
  args+=['--mount','type=bind,src='+str(metadata)+',dst=/workspace/alpha/.git']
 # Alpha's gitlink always sees exactly the same SDK, protected even during npm install.
 args+=['--mount','type=bind,src='+str(roots['SDK'])+',dst=/workspace/alpha/vendor/eliza,readonly']
 args+=['--mount','type=bind,src='+str(out)+',dst=/results']
 if projection.is_dir():
  args+=['--mount','type=bind,src='+str(projection)+',dst=/workspace/alpha/.eliza'+('' if name=='prepare-alpha-projection' else ',readonly')]
  # Protect the same projection through its second alias beneath writable results.
  if name!='prepare-alpha-projection':args+=['--mount','type=bind,src='+str(projection)+',dst=/results/projection,readonly']
 args+=['--mount','type=bind,src='+str(P)+',dst=/operator,readonly','--workdir',cwd]
 environment={'HOME':'/tmp/home','TMPDIR':'/tmp','CI':'true','NODE_ENV':'test','NODE_OPTIONS':resources['nodeOptions'].split('=',1)[1],'ELIZA_VAULT_DISABLE_KEYCHAIN':'1','ELIZA_LIVE_TEST':'0','BUN_INSTALL_CACHE_DIR':'/workspace/sdk/.cache/qualification-bun' if name=='install-sdk' else '/tmp/bun-cache','BUN_CONFIG_NO_AUTO_INSTALL':'true','VITEST_FS_MODULE_CACHE_PATH':'/results/fs-module-cache','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_COUNT':'4','GIT_CONFIG_KEY_0':'core.hooksPath','GIT_CONFIG_VALUE_0':'/dev/null','GIT_CONFIG_KEY_1':'core.fsmonitor','GIT_CONFIG_VALUE_1':'false','GIT_CONFIG_KEY_2':'protocol.allow','GIT_CONFIG_VALUE_2':'never','GIT_CONFIG_KEY_3':'maintenance.auto','GIT_CONFIG_VALUE_3':'false','GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_OPTIONAL_LOCKS':'0','GIT_TERMINAL_PROMPT':'0'}
 if name.startswith('owning-'):environment['ELIZA_QUALIFICATION_GROUP']=name
 for key,value in environment.items():args+=['--env',key+'='+value]
 args+=['--entrypoint',command[0],image,*command[1:]]
 # Register intent before the daemon can create anything. A lost CLI reply
 # is reconciled by exact name AND run labels, never removed by name alone.
 item={'cid':None,'name':cname,'createCompleted':False,'resources':resources};owned.append(item)
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

def git_metadata(root,*args,accepted=(0,)):
 env=dict(os.environ,GIT_NO_LAZY_FETCH='1',GIT_NO_REPLACE_OBJECTS='1',GIT_OPTIONAL_LOCKS='0',GIT_TERMINAL_PROMPT='0')
 command=['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.allow=never','-c','gc.auto=0','-c','maintenance.auto=false','-C',str(root),*args]
 text,_=phase('source-metadata-'+str(len(records)),command,10,accepted=accepted)
 return text.strip()

def verify_sources():
 for label,root in roots.items():
  selected=plan['candidates'][label]
  assert git_metadata(root,'rev-parse','HEAD')==selected['commit'] and git_metadata(root,'rev-parse','HEAD^{tree}')==selected['tree']
  assert not git_metadata(root,'diff','--no-ext-diff','--name-only','HEAD')
  assert not git_metadata(root,'ls-files','--others','--exclude-standard')
  assert not git_metadata(root,'config','--local','--name-only','--get-regexp',r'^(http\..*\.extraheader|credential\.|core\.sshcommand|include\.|includeif\.|url\..*\.insteadof)',accepted=(0,1))
  for relative,digest in manifest[label]['files'].items():assert sha(root/relative)==digest
  for directory in [root,root/'packages/host',root/'plugins/plugin-assistant']:
   for filename in ['.env','.env.local','.env.production','.env.test','.dev.vars']:assert not (directory/filename).exists()
 sdk=plan['candidates']['SDK']['commit'];alpha=roots['Alpha']
 assert git_metadata(alpha,'ls-tree','HEAD','vendor/eliza').split()[2]==sdk
 assert json.loads((alpha/'upstream.lock.json').read_text())['commit']==sdk
 assert json.loads((alpha/'patches/eliza/cloud-speech-client-manifest.json').read_text())['baseCommit']==sdk

def census(mode,label):
 directory=out/('dependencies-'+label.lower());directory.mkdir(exist_ok=True)
 meta=manifest[label];selected=plan['candidates'][label]
 phase('dependency-'+mode+'-'+label+'-'+str(len(records)),[sys.executable,'-I','-B',str(P/'dependency-census'/label/'inventory_dependencies.py'),mode,str(roots[label]),str(directory),selected['commit'],selected['tree'],meta['lockSHA256']],90)

def judge(group,failure):
 expected=oracle['files'][group['repository']+':'+group['file']];report=out/group['report']
 assert not failure, 'Owning process failed'
 if group['repository']=='SDK':
  registration=json.loads((out/(group['name']+'-registered.json')).read_text())
  observed=json.loads((out/(group['name']+'-results.json')).read_text())
  assert registration['state']=='ACTUAL_NORMAL_VITEST_REGISTRATION_BEFORE_RESULTS' and observed['accepted'] is True
  assert registration['oracleSHA256']==observed['oracleSHA256']==sha(P/'ORACLES.json')
  assert registration['module']=='/workspace/sdk/'+group['file']
  assert len(registration['cases'])==len(observed['results'])==expected['expectedSourceCaseCount']
  assert {r['id']for r in registration['cases']}=={r['id']for r in observed['results']}
  assert all(r['state']=='passed'for r in observed['results'])
  data=json.loads(report.read_text());assert len(data['testResults'])==1
  row=data['testResults'][0];assert pathlib.PurePosixPath(row['name'])==pathlib.PurePosixPath('/workspace/sdk')/group['file']
  rows=row['assertionResults'];assert rows and all(r['status']=='passed'for r in rows)
  assert collections.Counter(r['title']for r in rows)==collections.Counter(r['name']for r in registration['cases'])
  cases=len(rows)
 else:
  observed=json.loads((out/(group['name']+'-node-cases.json')).read_text())
  assert observed['accepted'] is True and observed['oracleSHA256']==sha(P/'ORACLES.json') and observed['topLevelAdapterSelectorUnset'] is True
  xml=ET.parse(report).getroot();assert xml.findall('.//testcase')
  assert not xml.findall('.//failure') and not xml.findall('.//error') and not xml.findall('.//skipped')
  cases=sum(1 for row in observed['registered']if row['scope']=='source-parent')
  assert cases==expected['expectedSourceCaseCount']
  if group['file']=='test/private-preview-cartesia-route.test.mjs':assert len(observed['adapterDiagnostics'])==9
 family_results[group['repository']+':'+group['file']]={'outcome':'passed','parentCaseCount':cases,'reportSHA256':sha(report),'actualCaseWitnessSHA256':sha(out/(group['name']+('-results.json'if group['repository']=='SDK'else'-node-cases.json'))),'closed':True}

try:
 verify_sources()
 guard_sdk,_=phase('known-incident-source-guard-SDK',[sys.executable,'-I','-B',str(P/'check_source.py'),'--kind','sdk','--repo',str(roots['SDK']),'--expected-head',plan['candidates']['SDK']['commit']],65)
 guard=json.loads(guard_sdk);assert guard['result']=='PASS' and guard['head']==plan['candidates']['SDK']['commit'];(out/'SOURCE-GUARD-SDK.json').write_text(json.dumps(guard,indent=2)+'\n')
 phase('host-capability',[sys.executable,'-I','-B',str(P/'verify-host.py')],20)
 for name in ['bun','node']:
  selected=plan['images'][name];phase('pull-'+name,['docker','pull',selected['repository']+'@'+selected['digest']],120)
 phase('toolchain-assembly',['docker','build','--network=none','--pull=false','-t',prefix+'-tools','-f',str(P/'Dockerfile'),str(P)],90)
 text,_=phase('toolchain-image',['docker','image','inspect',prefix+'-tools','--format','{{.Id}}'],10);image=text.strip();assert re.fullmatch('sha256:[a-f0-9]{64}',image)
 container_phase('versions','none','2g',['/usr/local/bin/node','/operator/verify-tools.mjs'],30)
 assert json.loads((out/'TOOLS.json').read_text())['accepted'] is True
 alpha=roots['Alpha'];before_refs=git_metadata(alpha,'for-each-ref','--format=%(refname) %(objectname)')
 assert not git_metadata(alpha,'config','--local','--name-only','--get-regexp',r'^(url\.|include\.|includeif\.|credential\.|http\.|core\.sshcommand|extensions\.partialclone|remote\..*\.(promisor|partialclonefilter|proxy))',accepted=(0,1))
 initial_shallow=git_metadata(alpha,'rev-parse','--is-shallow-repository')
 if initial_shallow=='true':
  command=['/usr/bin/git','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','credential.helper=','-c','http.extraHeader=','-c','http.https://github.com/.extraHeader=','-c','http.followRedirects=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','fetch.prune=false','-c','fetch.pruneTags=false','-c','remote.origin.prune=false','-c','fetch.writeCommitGraph=false','-c','fetch.parallel=1','-c','pack.threads=1','-c','submodule.recurse=false','-C','/workspace/alpha','fetch','--unshallow','--no-tags','--no-prune','--no-prune-tags','--no-recurse-submodules','--no-write-fetch-head','--refmap=','--no-auto-maintenance','https://github.com/eliza-research/alphaphone.git',plan['candidates']['Alpha']['commit']]
  container_phase('alpha-ancestry','bridge','2g',command,120,repository='Alpha',cwd='/workspace/alpha')
 else:assert initial_shallow=='false'
 assert git_metadata(alpha,'rev-parse','--is-shallow-repository')=='false'
 assert git_metadata(alpha,'for-each-ref','--format=%(refname) %(objectname)')==before_refs
 verify_sources()
 text,_=phase('known-incident-source-guard-Alpha',[sys.executable,'-I','-B',str(P/'check_source.py'),'--kind','product','--repo',str(alpha),'--expected-head',plan['candidates']['Alpha']['commit']],65)
 guard=json.loads(text);assert guard['result']=='PASS' and guard['head']==plan['candidates']['Alpha']['commit'] and guard['ancestryComplete'] is True
 (out/'SOURCE-GUARD-Alpha.json').write_text(json.dumps(guard,indent=2)+'\n')
 (out/'ALPHA-EXACT-ANCESTRY.json').write_text(json.dumps({'initialShallow':initial_shallow,'postShallow':False,'HEAD':plan['candidates']['Alpha']['commit'],'tree':plan['candidates']['Alpha']['tree'],'namedRefsUnchanged':True,'onlyOwnGitMetadataWritable':True,'trustedBootstrapExplicitlyAdmitted':True,'sourceCodeExecutedBeforeFullProductGuard':False},indent=2)+'\n')

 container_phase('install-sdk','bridge','4g',['/usr/local/bin/bun','install','--frozen-lockfile','--ignore-scripts','--no-progress'],600,repository='SDK',cwd='/workspace/sdk')
 verify_sources()
 container_phase('install-alpha','bridge','4g',['/usr/local/bin/npm','ci','--ignore-scripts','--no-audit','--no-fund'],600,repository='Alpha',cwd='/workspace/alpha')
 verify_sources()
 for label in roots:census('capture',label);census('verify',label)
 # Fresh job-owned mount target only; never a user checkout or SDK write overlay.
 assert not (roots['Alpha']/'.eliza').exists();(roots['Alpha']/'.eliza').mkdir();projection.mkdir()
 container_phase('prepare-alpha-projection','none','2g',['/usr/local/bin/node','scripts/prepare-client-features.mjs'],60,repository='Alpha',cwd='/workspace/alpha')
 container_phase('projection-baseline','none','2g',['/usr/local/bin/node','/operator/verify-projection.mjs','baseline'],45,repository='Alpha',cwd='/workspace/alpha')
 projection_baseline_sha=sha(out/'PROJECTION-BASELINE.json')
 container_phase('projection-and-owning-preflight','none','2g',['/usr/local/bin/node','/operator/owning-paired-preflight.mjs'],120)
 preflight=json.loads((out/'OWNING-PREFLIGHT.json').read_text());assert preflight['accepted'] and set(preflight['owners'])=={'App','Host','UI','Voice','AlphaProjection'}
 assert preflight['newHostContractsValueExports']==['parseChatFailureKind','parseChatTerminalFailure']
 verify_sources()
 for group in plan['groups']:
  assert not (out/group['report']).exists()
  failure=container_phase(group['name'],'none','2g',group['command'],group['phaseSeconds'],repository=group['repository'],cwd=group['cwd'],test_family=True)
  try:judge(group,failure)
  except (AssertionError,FileNotFoundError,ValueError,KeyError,ET.ParseError) as exc:
   family_results[group['repository']+':'+group['file']]={'outcome':'failed','errorType':type(exc).__name__,'closed':True}
  verify_sources()
 for label in roots:census('verify',label)
 container_phase('projection-postverify','none','2g',['/usr/local/bin/node','/operator/verify-projection.mjs','post'],45,repository='Alpha',cwd='/workspace/alpha')
 assert sha(out/'PROJECTION-BASELINE.json')==projection_baseline_sha
 post=json.loads((out/'PROJECTION-POSTVERIFY.json').read_text());baseline=json.loads((out/'PROJECTION-BASELINE.json').read_text())
 assert post['accepted'] is True and post['phase']=='post' and baseline['phase']=='baseline' and post['SDK']==baseline['SDK']==plan['candidates']['SDK']['commit'] and post['Alpha']==baseline['Alpha']==plan['candidates']['Alpha']['commit'] and post['stampSHA256']==baseline['stampSHA256']
 assert len(family_results)==12 and set(family_results)==set(oracle['files'])
 status='PASS_12_NORMAL_FILES_AND_PAIRED_PROJECTION_TYPES_AND_LIVE_HELD' if all(row['outcome']=='passed'for row in family_results.values()) else 'FAILED_NORMAL_FILE_FAMILY'
except BaseException as exc:run_error=type(exc).__name__+': '+str(exc)
finally:
 for index,item in enumerate(owned):
  try:cleanup_container(item,'cleanup-'+str(index))
  except ResourcePolicyError:pass
  except BaseException as exc:cleanup_errors.append({'cid':item['cid'],'error':str(exc)})
 resource_errors=[{'cid':item['cid'],**error}for item in owned for error in item.get('resourcePolicyFailures',[])]
 result={'state':'CLEANUP_FAILED' if cleanup_errors else 'RESOURCE_POLICY_FAILED' if resource_errors else status,'error':run_error,'phases':records,'containers':owned,'cleanupErrors':cleanup_errors,'resourcePolicyErrors':resource_errors,'families':family_results,'sources':plan['candidates'],'normalTypes':False,'wholeQualificationComplete':False,'normalSDKLifecycle':False,'actualModelVoiceCalendarDeviceOrDeploymentAcceptance':False,'oldACKCountsOrManualWaiver':False,'hostCleanup':False}
 (out/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
raise SystemExit(0 if status=='PASS_12_NORMAL_FILES_AND_PAIRED_PROJECTION_TYPES_AND_LIVE_HELD' and not run_error and not cleanup_errors and not resource_errors else 1)
