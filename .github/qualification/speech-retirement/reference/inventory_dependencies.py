"""Bounded data-only physical census, run only inside separately admitted hosted job."""
import hashlib,itertools,json,os,pathlib,stat,sys,time
P=pathlib.Path(__file__).resolve().parent
mode,src,out,commit,tree,lock=sys.argv[1:]
assert mode in ('capture','verify')
source=pathlib.Path(src).resolve();output=pathlib.Path(out).resolve();start=time.monotonic()
limit=134217728
roots=json.loads((P/'WORKSPACE-DEPENDENCY-ROOTS.json').read_text())
assert len(roots)==len(set(roots))==135

def digest(file):
 h=hashlib.sha256()
 with file.open('rb') as f:
  while b:=f.read(65536):
   assert time.monotonic()-start<85,'Dependency census wall bound'
   h.update(b)
 return h.hexdigest()

def rows():
 def encode(value):
  assert time.monotonic()-start<85,'Dependency census wall bound'
  return json.dumps(value,separators=(',',':'),sort_keys=True)+'\n'
 def walk_error(error):raise error
 for relative in sorted(roots):
  assert not pathlib.PurePosixPath(relative).is_absolute() and '..' not in pathlib.PurePosixPath(relative).parts
  root=source/relative
  try:metadata=root.lstat()
  except FileNotFoundError:
   yield encode({'path':relative,'kind':'root','state':'absent'});continue
  if stat.S_ISLNK(metadata.st_mode):
   assert root.resolve(strict=True).is_relative_to(source) and root.is_dir(),'Invalid dependency root link'
   rootstate={'path':relative,'kind':'root','state':'symlink','target':os.readlink(root)}
  else:
   assert stat.S_ISDIR(metadata.st_mode) and root.resolve(strict=True).is_relative_to(source)
   rootstate={'path':relative,'kind':'root','state':'directory'}
  yield encode(rootstate)
  for directory,dirs,files in os.walk(root,followlinks=False,onerror=walk_error):
   dirs.sort();files.sort()
   for name in sorted(files+[x for x in dirs if (pathlib.Path(directory)/x).is_symlink()]):
    f=pathlib.Path(directory)/name;rel=str(f.relative_to(source))
    if f.is_symlink():
     assert f.resolve(strict=True).is_relative_to(source),'External dependency symlink'
     value={'path':rel,'kind':'symlink','target':os.readlink(f)}
    else:
     assert f.is_file() and f.resolve(strict=True).is_relative_to(source)
     value={'path':rel,'kind':'file','bytes':f.stat().st_size,'sha256':digest(f)}
    yield encode(value)

inventory=output/'dependency-files.jsonl'
if mode=='capture':
 total=0;counts={'root':0,'file':0,'symlink':0}
 with inventory.open('x') as f:
  for line in rows():
   total+=len(line.encode());assert total<=limit,'Dependency receipt byte bound'
   f.write(line);counts[json.loads(line)['kind']]+=1
 assert counts['root']==135 and counts['file']>0
 receipt={'sourceRoot':str(source),'sourceCommit':commit,'sourceTree':tree,'bunLockSHA256':lock,
  'platform':'linux-x64','files':counts['file'],'rootStates':counts['root'],'symlinks':counts['symlink'],
  'entries':sum(counts.values()),'inventorySHA256':digest(inventory),'inventoryBytes':total,
  'ignoreScripts':True,'nativeHooksExecuted':False,'scope':'Actual canonical manifest/frozen-lock installed dependency bytes and all declared root states; not normal native hook/lifecycle qualification'}
 with (output/'DEPENDENCY-INVENTORY.json').open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
 print(json.dumps({'counts':counts,'inventoryBytes':total,'inventorySHA256':receipt['inventorySHA256']}))
else:
 d=json.loads((output/'DEPENDENCY-INVENTORY.json').read_text());assert digest(inventory)==d['inventorySHA256']
 total=0;counts={'root':0,'file':0,'symlink':0}
 with inventory.open() as f:
  for old,new in itertools.zip_longest(f,rows()):
   assert old==new,'Physical dependency/root set or bytes changed'
   total+=len(old.encode());assert total<=limit;counts[json.loads(old)['kind']]+=1
 assert counts['root']==d['rootStates']==135 and counts['file']==d['files'] and counts['symlink']==d['symlinks'] and sum(counts.values())==d['entries']
 print(json.dumps({'verifiedCounts':counts,'inventorySHA256':d['inventorySHA256']}))
