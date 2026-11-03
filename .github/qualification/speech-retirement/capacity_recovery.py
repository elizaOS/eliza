"""CI-only conditional recovery of one unused preinstalled hosted Android SDK.

Prepared source only. The only deletion command contains a fixed literal target.
Never imported by the SDK or executed on macOS. A fresh exact Root GO is required.
"""
import hashlib,json,os,pathlib,re,selectors,shutil,signal,stat,subprocess,sys,time,urllib.request
P=pathlib.Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sys.platform=='linux' and os.uname().machine=='x86_64'
assert os.environ['GITHUB_ACTIONS']=='true' and os.environ['RUNNER_ENVIRONMENT']=='github-hosted'
assert os.environ['GITHUB_REPOSITORY']=='elizaOS/eliza' and os.environ['GITHUB_EVENT_NAME']=='workflow_dispatch'
assert os.environ['GITHUB_RUN_ATTEMPT']=='1' and os.environ['GITHUB_JOB']=='qualify'
assert os.environ['ImageOS']=='ubuntu24' and (3,12)<=sys.version_info[:2]<(3,16)
assert os.geteuid()!=0
plan=json.loads((P/'PLAN.json').read_text());manifest=json.loads((P/'SOURCE-MANIFEST.json').read_text())
policy=json.loads((P/'CAPACITY-RECOVERY-POLICY.json').read_text())
for name,want in json.loads((P/'SEAL.json').read_text())['files'].items():assert sha(P/name)==want,name
go_path=pathlib.Path(os.environ['ROOT_GO_JSON']).resolve();go=json.loads(go_path.read_text())
assert go['action']=='ONE_EXACT_QUALIFICATION_RUN' and go['recipe']=='ack-normal-fullfiles' and go['mode']=='qualify'
assert go['allowHostedFrozenLockSetup'] is True and go['allowHostedUnusedAndroidCleanup'] is True
assert re.fullmatch('[a-f0-9]{32}',go['intentId'])
assert go['workflowCommit']==os.environ['GITHUB_SHA']==os.environ['EXPECTED_WORKFLOW_SHA']
assert go['sourceCommit']==manifest['commit'] and go['sourceTree']==manifest['tree']
assert go['operatorSealSHA256']==sha(P/'SEAL.json')
assert go['capacityRecoveryPolicySHA256']==sha(P/'CAPACITY-RECOVERY-POLICY.json')==plan['capacityRecoveryPolicySHA256']
assert go['capacityRecoveryScriptSHA256']==sha(P/'capacity_recovery.py')==policy['scriptSHA256']
assert go['resourcePolicySHA256']==plan['resourcePolicySHA256'] and go['oracleSHA256']==plan['oracleSHA256']
assert go['expectedRegistrations']==1122 and go['expectedPassed']==1121 and go['expectedManualUnexecuted']==1
assert go['manualTracePolicy']=='unexecuted-no-inputs'
assert 0<go['issuedEpoch']<=time.time()<go['expiresEpoch']<=go['issuedEpoch']+1200
temp=pathlib.Path(os.environ['RUNNER_TEMP']).resolve()
assert go_path==temp/'speech-root-go.json' and go['output']==str(temp/'speech-retirement-results')
assert P==pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()/'operator/.github/qualification/speech-retirement'
claim=json.loads((temp/'speech-intent-claim.json').read_text())
runid=os.environ['GITHUB_RUN_ID'];assert runid.isdigit()
assert claim['actualRunId']==runid and claim['attempt']==1 and claim['rootGOsha256']==sha(go_path)
for key in ['intentId','workflowCommit','sourceCommit','sourceTree','operatorSealSHA256','resourcePolicySHA256','oracleSHA256','capacityRecoveryPolicySHA256','capacityRecoveryScriptSHA256','allowHostedUnusedAndroidCleanup','expectedRegistrations','expectedPassed','expectedManualUnexecuted','manualTracePolicy','issuedEpoch','expiresEpoch']:assert claim[key]==go[key],key
out=temp/'speech-capacity-results';out.mkdir()
start=time.monotonic();free_start=shutil.disk_usage(out).free;records=[]
token=os.environ.pop('GH_TOKEN')
result={'state':'FAILED','runId':runid,'attempt':1,'intentId':go['intentId'],'rootGOsha256':sha(go_path),'workflowCommit':go['workflowCommit'],'sourceCommit':manifest['commit'],'sourceTree':manifest['tree'],'operatorSealSHA256':go['operatorSealSHA256'],'capacityRecoveryPolicySHA256':go['capacityRecoveryPolicySHA256'],'capacityRecoveryScriptSHA256':go['capacityRecoveryScriptSHA256'],'resourcePolicySHA256':go['resourcePolicySHA256'],'oracleSHA256':go['oracleSHA256'],'target':'/usr/local/lib/android/sdk','action':'NOT_STARTED','beforeAvailableBytes':free_start,'afterAvailableBytes':None,'entryFloorBytes':17179869184,'sourceCodeExecuted':False,'imagesPulledOrInstalled':False,'runnerEnvironment':{'ImageOS':os.environ['ImageOS'],'ImageVersion':os.environ['ImageVersion'],'architecture':os.uname().machine},'hostedMetadataVerified':False,'pathIdentity':[],'layout':[],'error':None}
with (out/'CAPACITY-CLAIM.json').open('x')as f:json.dump({'rootGOsha256':sha(go_path),'intentId':go['intentId'],'runId':runid,'workflowCommit':go['workflowCommit'],'capacityRecoveryPolicySHA256':go['capacityRecoveryPolicySHA256'],'capacityRecoveryScriptSHA256':go['capacityRecoveryScriptSHA256']},f,indent=2)
def api(path):
 request=urllib.request.Request('https://api.github.com/repos/elizaOS/eliza/'+path,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
 with urllib.request.urlopen(request,timeout=20)as response:raw=response.read(1048577)
 assert len(raw)<=1048576
 return json.loads(raw)

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

def snapshot(path,value):
 return {'path':path,'device':value.st_dev,'inode':value.st_ino,'uid':value.st_uid,'gid':value.st_gid,'mode':stat.S_IMODE(value.st_mode),'type':'directory'if stat.S_ISDIR(value.st_mode)else'regular'if stat.S_ISREG(value.st_mode)else'symlink'if stat.S_ISLNK(value.st_mode)else'other','size':value.st_size,'ctimeNS':value.st_ctime_ns}
def validate_sdk():
 fds=[]
 try:
  fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);fds.append(fd)
  current='/';root_stat=os.fstat(fd);device=root_stat.st_dev;identity=[snapshot('/',root_stat)];result['pathIdentity']=identity
  assert root_stat.st_uid==0 and root_stat.st_gid==0 and stat.S_IMODE(root_stat.st_mode)&0o022==0,'Unknown root ownership/mode'
  for part in ('usr','local','lib','android','sdk'):
   current=current.rstrip('/')+'/'+part
   value=os.stat(part,dir_fd=fd,follow_symlinks=False)
   identity.append(snapshot(current,value))
   assert stat.S_ISDIR(value.st_mode) and value.st_uid==0 and value.st_gid==0,current
   assert value.st_dev==device==out.stat().st_dev,'Wrong filesystem'
   if part!='sdk':assert stat.S_IMODE(value.st_mode)&0o022==0,'Writable target parent'
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd);fds.append(child)
   opened=os.fstat(child);assert (opened.st_dev,opened.st_ino)==(value.st_dev,value.st_ino)
   identity[-1]=snapshot(current,opened);fd=child
  assert current=='/usr/local/lib/android/sdk' and pathlib.Path(current).resolve(strict=True)==pathlib.Path(current)
  assert os.environ.get('ANDROID_HOME')==current and os.environ.get('ANDROID_SDK_ROOT')==current
  assert os.access(current,os.R_OK|os.W_OK|os.X_OK,effective_ids=True),'SDK payload not writable by unprivileged hosted runner'
  layout=[];result['layout']=layout
  for relative,is_dir in [('build-tools',True),('platform-tools',True),('platforms',True),('cmdline-tools',True),('ndk',True),('licenses',True),('packages.xml',False),('platform-tools/adb',False),('cmdline-tools/latest/bin/sdkmanager',False)]:
   at=fd;opened_fds=[]
   try:
    parts=relative.split('/')
    for index,name in enumerate(parts):
     value=os.stat(name,dir_fd=at,follow_symlinks=False)
     result.setdefault('layoutComponents',[]).append(snapshot(current+'/'+ '/'.join(parts[:index+1]),value))
     directory=index<len(parts)-1 or is_dir
     assert (stat.S_ISDIR(value.st_mode)if directory else stat.S_ISREG(value.st_mode)),'Unknown preinstalled layout'
     assert value.st_uid==0 and value.st_gid==0 and value.st_dev==device,'Layout ownership/filesystem'
     nxt=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|(os.O_DIRECTORY if directory else 0),dir_fd=at);opened_fds.append(nxt)
     opened=os.fstat(nxt);assert (opened.st_dev,opened.st_ino)==(value.st_dev,value.st_ino)
     if directory:assert os.access('.',os.R_OK|os.W_OK|os.X_OK,dir_fd=nxt,effective_ids=True),'SDK layout directory not writable by runner'
     at=nxt
    if not is_dir:assert 0<opened.st_size<=536870912
    layout.append(snapshot(current+'/'+relative,opened))
   finally:
    for opened_fd in reversed(opened_fds):os.close(opened_fd)
  # Non-writable root-owned parents pin the target directory entry. Revalidate
  # the exact entry immediately before the fixed, non-link-following command.
  for row in identity:
   now=os.lstat(row['path']);assert not stat.S_ISLNK(now.st_mode)
   assert (now.st_dev,now.st_ino,now.st_uid,now.st_gid)==(row['device'],row['inode'],0,0)
  return identity,layout
 finally:
  for fd in reversed(fds):os.close(fd)

def decode_mount_path(encoded):
 result=[];index=0;escapes={'040':' ','011':'\t','012':'\n','134':'\\'}
 while index<len(encoded):
  if encoded[index]=='\\':
   code=encoded[index+1:index+4];assert len(code)==3 and code in escapes,'Unknown mount path escape'
   result.append(escapes[code]);index+=4
  else:result.append(encoded[index]);index+=1
 return ''.join(result)
def parse_mountinfo(raw):
 assert 0<len(raw)<=8388608,'Unknown mount table size'
 mounts=[];lines=raw.decode('utf-8').splitlines()
 for line in lines:
  left,right=line.split(' - ',1);fields=left.split();assert len(fields)>=6 and len(right.split())>=3
  assert fields[0].isdigit()and fields[1].isdigit()and re.fullmatch(r'[0-9]+:[0-9]+',fields[2])
  mount=decode_mount_path(fields[4]);assert mount.startswith('/')and '\0'not in mount
  assert mount=='/'or not mount.startswith('//')and not mount.endswith('/')and all(part not in ('','.','..')for part in mount[1:].split('/')),'Noncanonical mount path'
  target='/usr/local/lib/android/sdk'
  if mount!='/'and(mount==target or mount.startswith(target+'/')or target.startswith(mount+'/')):mounts.append(mount)
 return {'sha256':hashlib.sha256(raw).hexdigest(),'lines':len(lines),'sdkMountpoints':mounts}
def mount_snapshot():
 value=parse_mountinfo(pathlib.Path('/proc/self/mountinfo').read_bytes())
 value['mountNamespace']=os.readlink('/proc/self/ns/mnt');return value

error=None
try:
 assert os.environ['ImageVersion']in plan['hostEnvironment']['allowedImageVersions']
 os_release=dict(line.strip().split('=',1)for line in pathlib.Path('/etc/os-release').read_text().splitlines()if'='in line)
 assert os_release['ID'].strip('"')=='ubuntu' and os_release['VERSION_ID'].strip('"')=='24.04'
 remote=api('actions/runs/'+runid)
 assert remote['run_attempt']==1 and remote['head_sha']==go['workflowCommit']and remote['event']=='workflow_dispatch'and remote['workflow_id']==269943084 and remote['path']=='.github/workflows/cloud-tests.yml'
 jobs=api('actions/runs/'+runid+'/jobs?per_page=10')['jobs'];assert len(jobs)==1
 job=jobs[0];assert job['name']=='qualify'and job['run_id']==int(runid)and job['run_attempt']==1 and job['runner_group_id']==0 and job['runner_group_name']=='GitHub Actions'and job['labels']==['ubuntu-24.04']and job['runner_name'].startswith('GitHub Actions ')and job['runner_id']>0
 artifact_id=os.environ['CLAIM_ARTIFACT_ID'];assert artifact_id.isdigit();artifact=api('actions/artifacts/'+artifact_id)
 assert artifact['name']=='speech-intent-'+go['intentId']and artifact['workflow_run']['id']==int(runid)and artifact['expired']is False
 result['hostedIdentity']={'ImageOS':os.environ['ImageOS'],'ImageVersion':os.environ['ImageVersion'],'architecture':os.uname().machine,'runnerGroup':job['runner_group_name'],'runnerGroupId':job['runner_group_id'],'runnerId':job['runner_id'],'runnerName':job['runner_name'],'labels':job['labels'],'jobId':job['id'],'claimArtifactId':int(artifact_id),'claimArtifactDigest':artifact['digest']}
 result['hostedMetadataVerified']=True
 for key,value in {'GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1','GIT_OPTIONAL_LOCKS':'0','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_SYSTEM':'/dev/null'}.items():os.environ[key]=value
 source=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()/'source'
 for label,revision,expected in [('source-head','HEAD',manifest['commit']),('source-tree','HEAD^{tree}',manifest['tree'])]:
  observed,_=phase(label,['/usr/bin/git','--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',str(source),'rev-parse',revision],10)
  assert observed.strip()==expected,'Wrong exact source checkout'
 result['beforeAvailableBytes']=shutil.disk_usage(out).free
 if result['beforeAvailableBytes']>=17179869184:
  result['action']='SKIPPED';result['skipReason']='Original entry floor already satisfied; no SDK path inspection or deletion'
  result['state']='SKIPPED_CAPACITY_SUFFICIENT'
 else:
  assert result['beforeAvailableBytes']>=8589934592,'Below unchanged stop floor'
  mounts=mount_snapshot();result['mountChecks']=[mounts];assert not mounts['sdkMountpoints'],'Mountpoint at or under fixed SDK target'
  identity,layout=validate_sdk();result['pathIdentity']=identity;result['layout']=layout
  binaries=[]
  for path in ('/usr/bin/find',):
   value=os.lstat(path);assert stat.S_ISREG(value.st_mode)and value.st_uid==0 and not stat.S_ISLNK(value.st_mode)
   assert stat.S_IMODE(value.st_mode)&0o022==0,'Writable privileged binary'
   binaries.append({**snapshot(path,value),'sha256':sha(pathlib.Path(path))})
  result['commandBinaryIdentity']=binaries
  os.environ['LC_ALL']='C'
  version,_=phase('gnu-find-version',['/usr/bin/find','--version'],10)
  matched=re.match(policy['gnuFindVersionPattern'],version);assert matched,'Unrecognized GNU find version'
  result['gnuFindVersion']=matched.group(1);result['gnuFindVersionOutputSHA256']=hashlib.sha256(version.encode()).hexdigest()
  assert time.time()+70<=go['expiresEpoch'],'Insufficient finite Root window'
  command=['/usr/bin/find','-P','/usr/local/lib/android/sdk','-xdev','-depth','-mindepth','1','-delete']
  assert command==policy['fixedCommand'];result['fixedCommand']=command
  # All path components are revalidated after binary/source checks, before launch.
  again,_=validate_sdk();assert again==identity,'Fixed target identity changed'
  mounts_now=mount_snapshot();result['mountChecks'].append(mounts_now)
  assert not mounts_now['sdkMountpoints']and mounts_now['mountNamespace']==mounts['mountNamespace'],'Mount boundary changed'
  result['action']='CLEAR_FIXED_UNUSED_PREINSTALLED_SDK_PAYLOAD_STARTED'
  cleanup_output,_=phase('clear-fixed-unused-android-sdk-payload',command,60)
  assert not cleanup_output.strip(),'Unexpected cleanup diagnostics'
  fd=os.open('/usr/local/lib/android/sdk',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
  try:
   stub=os.fstat(fd);assert (stub.st_dev,stub.st_ino,stub.st_uid,stub.st_gid)==(identity[-1]['device'],identity[-1]['inode'],0,0)
   with os.scandir(fd)as entries:assert next(entries,None)is None,'Fixed SDK payload remains after command'
   result['targetStubAfter']=snapshot('/usr/local/lib/android/sdk',stub);result['targetPayloadEmptyAfter']=True
  finally:os.close(fd)
  after_mounts=mount_snapshot();result['mountChecks'].append(after_mounts)
  assert not after_mounts['sdkMountpoints']and after_mounts['mountNamespace']==mounts['mountNamespace'],'Mount boundary changed'
  result['state']='RECOVERED_FIXED_UNUSED_ANDROID_PAYLOAD'
 result['afterAvailableBytes']=shutil.disk_usage(out).free
 assert result['afterAvailableBytes']>=17179869184,'Original entry floor still not satisfied'
except BaseException as exc:
 error=type(exc).__name__+': '+str(exc);result['state']='FAILED';result['error']=error
finally:
 result['afterAvailableBytes']=shutil.disk_usage(out).free
 result['phases']=records;result['allOwnedGroupsEmpty']=all(row['ownedGroupEmpty']for row in records)
 result['seconds']=time.monotonic()-start
 if not result['allOwnedGroupsEmpty']:result['state']='FAILED_UNCLOSED_OWNED_GROUP'
 (out/'CAPACITY-RECOVERY.json').write_text(json.dumps(result,indent=2)+'\n')
raise SystemExit(0 if result['state']in('SKIPPED_CAPACITY_SUFFICIENT','RECOVERED_FIXED_UNUSED_ANDROID_PAYLOAD')and not error and result['allOwnedGroupsEmpty']else 1)
