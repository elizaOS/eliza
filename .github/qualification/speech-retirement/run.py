"""Ephemeral hosted verifier: metadata-only or explicitly admitted qualification."""
import hashlib,json,os,pathlib,re,selectors,shutil,signal,subprocess,sys,time,xml.etree.ElementTree as ET
P=pathlib.Path(__file__).resolve().parent
mode,source_arg,out_arg=sys.argv[1:]
assert mode in ('metadata','qualify')
source=pathlib.Path(source_arg).resolve();out=pathlib.Path(out_arg).resolve()
assert out.is_relative_to(pathlib.Path(os.environ['RUNNER_TEMP']).resolve()) and not out.exists()
assert os.environ['GITHUB_RUN_ATTEMPT']=='1' and os.environ['GITHUB_SHA']==os.environ['EXPECTED_WORKFLOW_SHA']
assert os.environ['RUNNER_ENVIRONMENT']=='github-hosted' and os.uname().machine=='x86_64'
assert time.time()<int(os.environ['EXPIRES_EPOCH'])<=time.time()+1200
plan=json.loads((P/'PLAN.json').read_text());manifest=json.loads((P/'SOURCE-MANIFEST.json').read_text());oracle=json.loads((P/'ORACLES.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for file,expected in json.loads((P/'SEAL.json').read_text())['files'].items():assert sha(P/file)==expected,file
out.mkdir(parents=True);start=time.monotonic();free_start=shutil.disk_usage(out).free
records=[];owned=[];status='FAILED';run_error=None;cleanup_errors=[]
runid=os.environ['GITHUB_RUN_ID'];assert runid.isdigit();prefix='speech-retirement-'+runid+'-1'
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
  if code not in accepted:raise RuntimeError('unexpected exit '+str(code))
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
inspect_format='{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}}}'
def inspect_container(key,label,cleanup=False):
 text,code=phase(label,['docker','container','inspect','--format',inspect_format,key],10,accepted=(0,1),cleanup=cleanup)
 if code==1:
  assert 'No such object' in text or 'No such container' in text,'Container lookup failed ambiguously'
  return None
 return json.loads(text)
def check_container(value,item):
 assert re.fullmatch('[a-f0-9]{64}',value['Id']) and value['Name']=='/'+item['name']
 if item['cid'] is not None:assert value['Id']==item['cid']
 assert value['Labels']['org.eliza.qualification-run']==runid and value['Labels']['org.eliza.qualification-kind']=='speech-retirement'
def container_phase(name,network,memory,command,timeout,rw=False):
 cname=prefix+'-'+name
 assert inspect_container(cname,name+'-absence') is None,'Preexisting container name; no mutation'
 args=['docker','create','--name',cname,'--label','org.eliza.qualification-run='+runid,'--label','org.eliza.qualification-kind=speech-retirement','--network',network,'--cpus','2','--memory',memory,'--memory-swap',memory,'--pids-limit','256','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,size=536870912','--mount','type=bind,src='+str(source)+',dst=/workspace'+('' if rw else ',readonly'),'--mount','type=bind,src='+str(out)+',dst=/results','--workdir','/workspace','--env','HOME=/tmp/home','--env','TMPDIR=/tmp','--env','CI=true','--env','NODE_ENV=test','--env','NODE_OPTIONS=--max-old-space-size=1536','--env','ELIZA_VAULT_DISABLE_KEYCHAIN=1','--env','ELIZA_LIVE_TEST=0','--env','BUN_INSTALL_CACHE_DIR=/workspace/.qualification-cache','--entrypoint',command[0],image,*command[1:]]
 # Register intent before the daemon can create anything. A lost CLI reply
 # is reconciled by exact name AND run labels, never removed by name alone.
 item={'cid':None,'name':cname,'createCompleted':False};owned.append(item)
 text,_=phase(name+'-create',args,20);cid=text.strip();assert re.fullmatch('[a-f0-9]{64}',cid)
 item['cid']=cid;item['createCompleted']=True
 check_container(inspect_container(cid,name+'-identity'),item)
 phase(name,['docker','start','--attach',cid],timeout)
 check_container(inspect_container(cid,name+'-postidentity'),item)
verify=lambda:None
try:
 text,_=phase('docker-version',['docker','version','--format','{{.Server.Version}}'],10);daemon=text.strip()
 metadata={'ImageVersion':os.environ.get('ImageVersion'),'ImageOS':os.environ.get('ImageOS'),'dockerServer':daemon,'freeBytes':free_start,'pid':os.getpid(),'pgid':os.getpgrp(),'processIdentity':identity(os.getpid()),'mode':mode,'imagePulls':False,'sourceExecuted':False}
 (out/'runner.json').write_text(json.dumps(metadata,indent=2)+'\n')
 if mode=='metadata':
  status='METADATA_ONLY_NO_PULL_NO_SOURCE_EXECUTION'
 else:
  assert os.environ['ImageVersion']==os.environ['EXPECTED_RUNNER_IMAGE']==plan['reviewedRunner']['ImageVersion']
  assert daemon==os.environ['EXPECTED_DOCKER_SERVER']==plan['reviewedRunner']['dockerServer']
  assert os.environ.get('ImageOS')==plan['reviewedRunner']['ImageOS']
  assert free_start>=plan['resourceBounds']['minimumStartFreeBytes']
  # Execute the independently reviewed guard, not any source repository script.
  guard,_=phase('known-incident-source-guard',[sys.executable,'-I','-B',str(P/'check_source.py'),'--repo',str(source),'--kind','sdk','--expected-head',manifest['commit']],65)
  assert json.loads(guard)['result']=='PASS'
  head,_=phase('source-head',['git','-C',str(source),'rev-parse','HEAD'],10);assert head.strip()==manifest['commit']
  tree,_=phase('source-tree',['git','-C',str(source),'rev-parse','HEAD^{tree}'],10);assert tree.strip()==manifest['tree']
  def verify():
   assert sha(source/'bun.lock')==manifest['bunLockSHA256']
   for file,expected in manifest['files'].items():assert sha(source/file)==expected,file
  verify()
  for name,filename,repo in [('bun','BUN-IMAGE.json','oven/bun'),('node','NODE-IMAGE.json','library/node')]:
   digest=json.loads((P/filename).read_text())['selectedDigest'];phase('pull-'+name,['docker','pull',repo+'@'+digest],120)
  phase('toolchain-build',['docker','build','--network=none','--pull=false','-t',prefix+'-tools','-f',str(P/'Dockerfile'),str(P)],90)
  text,_=phase('toolchain-image',['docker','image','inspect',prefix+'-tools','--format','{{.Id}}'],10);image=text.strip();assert re.fullmatch('sha256:[a-f0-9]{64}',image)
  container_phase('versions','none','2g',['/usr/local/bin/node','-e',"const c=require('child_process'),f=require('fs'),h=require('crypto');if(process.versions.node!=='24.15.0')throw Error('Node mismatch');let b=c.execFileSync('/usr/local/bin/bun',['--version'],{encoding:'utf8'}).trim();if(b!=='1.4.2')throw Error('Bun mismatch');console.log(JSON.stringify({node:process.versions.node,bun:b,bunSHA256:h.createHash('sha256').update(f.readFileSync('/usr/local/bin/bun')).digest('hex'),nodeSHA256:h.createHash('sha256').update(f.readFileSync('/usr/local/bin/node')).digest('hex')}));"],20)
  container_phase('install','bridge','4g',['/usr/local/bin/bun','install','--frozen-lockfile','--ignore-scripts','--no-progress'],600,rw=True)
  verify();config=source/'.qualification';config.mkdir(exist_ok=False);shutil.copy2(P/'backend.config.mts',config/'backend.config.mts')
  (out/'vitest/node_modules').mkdir(parents=True);(out/'vitest/package.json').write_text('{"private":true,"workspaces":[]}')
  container_phase('workerd','none','2g',['/usr/local/bin/bun','--conditions=eliza-source','test','--config=/dev/null','packages/cloud/api/__tests__/speech-relay-worker.test.ts','--test-name-pattern','pre-hello revoke|socket Stop settles|authoritative org','--reporter=junit','--reporter-outfile=/results/workerd.xml'],90)
  cases=ET.parse(out/'workerd.xml').getroot().findall('.//testcase');assert not any(c.find('failure') is not None or c.find('error') is not None for c in cases)
  passed=[c.attrib['name'] for c in cases if c.find('skipped') is None];skipped=[c.attrib['name'] for c in cases if c.find('skipped') is not None]
  assert sorted(passed)==sorted(oracle['workerdPassedNames']) and sorted(skipped)==sorted(oracle['workerdSkippedNames']) and len(cases)==8
  api_passed=0
  for index,(file,expected) in enumerate(oracle['apiBunByFile'].items()):
   # One real Bun process per API file, preserving the canonical runner's
   # isolation model. Source conditions are explicit; no dispatcher patch.
   report=f'api-{index}.xml'
   container_phase(f'api-{index}','none','2g',['/usr/local/bin/bun','--conditions=eliza-source','test','--config=/dev/null',file,'--timeout=60000','--reporter=junit',f'--reporter-outfile=/results/{report}'],60)
   cases=ET.parse(out/report).getroot().findall('.//testcase')
   assert all(c.find('failure') is None and c.find('error') is None and c.find('skipped') is None for c in cases), file
   assert len(cases)==expected['count'] and sorted(c.attrib['name'] for c in cases)==sorted(expected['names']), file
   api_passed+=len(cases)
  assert api_passed==oracle['apiBunPassedTotal']==40
  container_phase('units','none','2g',['/usr/local/bin/node','node_modules/vitest/vitest.mjs','run','--configLoader','runner','--config','.qualification/backend.config.mts','--reporter=json','--outputFile=/results/units.json'],90)
  units=json.loads((out/'units.json').read_text());assert units['numFailedTests']==0 and units['numPassedTests']==units['numTotalTests']==oracle['unitPassedTotal']
  assert units.get('numPendingTests',0)==0 and units.get('numTodoTests',0)==0
  observed={}
  for item in units['testResults']:
   relative=str(pathlib.PurePosixPath(item['name']).relative_to('/workspace'));assert relative not in observed and item['status']=='passed'
   assertions=item['assertionResults'];assert assertions and all(x['status']=='passed' for x in assertions);observed[relative]=len(assertions)
  assert observed==oracle['unitCountsByFile'];verify();status='PASS_BUN_API40_HOST14_WORKERD3_NOT_FULL_RELEASE'
except BaseException as exc:run_error=type(exc).__name__+': '+str(exc)
finally:
 for index,item in enumerate(owned):
  try:
   key=item['cid'] or item['name']
   value=inspect_container(key,f'cleanup-{index}-identity',cleanup=True)
   if value:
    check_container(value,item)
    item['cid']=value['Id']
    phase(f'cleanup-{index}-remove',['docker','rm','-f',item['cid']],10,cleanup=True)
    assert inspect_container(item['cid'],f'cleanup-{index}-absence',cleanup=True) is None
   elif not item['createCompleted']:
    # A missing reply plus an absent lookup cannot prove a delayed create
    # never happened. Preserve uncertainty instead of claiming cleanup.
    raise RuntimeError('Container creation outcome unknown; no matching container observed')
  except BaseException as exc:cleanup_errors.append({'cid':item['cid'],'error':str(exc)})
 result={'state':status if not cleanup_errors else 'CLEANUP_FAILED','error':run_error,'phases':records,'containers':owned,'cleanupErrors':cleanup_errors,'seconds':time.monotonic()-start,'liveProviders':False,'normalFullSuiteAndTypes':False}
 (out/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n')
raise SystemExit(0 if not run_error and not cleanup_errors else 1)
