#!/usr/bin/env python3
"""Validate all locally generated runtime/model bytes before and after explicit installation."""
from pathlib import Path
import argparse,hashlib,json,shutil,zipfile
b=Path(__file__).resolve().parent
p=argparse.ArgumentParser();target=p.add_mutually_exclusive_group(required=True);target.add_argument('--module');target.add_argument('--repository',help='Consumer repository with android/local-speech');p.add_argument('--test-assets');a=p.parse_args()
module=Path(a.module).resolve() if a.module else Path(a.repository).resolve()/'android/local-speech'
if a.repository and not a.test_assets:a.test_assets=str(Path(a.repository).resolve()/'android/app/src/androidTest/assets')
source=b/'source/android/local-speech'
def require(ok,message):
 if not ok:raise ValueError(message)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def regular(path):require(path.is_file() and not path.is_symlink(),'Expected regular file: '+str(path))
def members(root):
 require(root.is_dir() and not root.is_symlink(),'Expected directory: '+str(root))
 result=set()
 for path in root.rglob('*'):
  require(not path.is_symlink(),'Symlink refused: '+str(path))
  if path.is_file():result.add(path.relative_to(root).as_posix())
  else:require(path.is_dir(),'Special file refused')
 return result
regular(module/'build.gradle');regular(source/'runtime-manifest.json')
runtime_bytes=(source/'runtime-manifest.json').read_bytes();runtime_digest=hashlib.sha256(runtime_bytes).hexdigest();manifest=json.loads(runtime_bytes);require(manifest.get('noEspeak') is True,'Runtime must exclude eSpeak')
require({q['abi'] for q in manifest['qualifiedAbis']}=={'arm64-v8a','x86_64'},'Both qualified ABIs required')
for q in manifest['qualifiedAbis']:require(q.get('noEspeakSources') is True and q.get('noEspeakSymbols') is True,'Unqualified native runtime')
archive=source/'libs/sherpa-onnx-1.13.8-no-espeak.aar';regular(archive);require(sha(archive)==manifest['aarSha256'],'Runtime hash mismatch')
require(members(source/'libs')=={archive.name},'Unexpected runtime files')
with zipfile.ZipFile(archive) as jar:
 expected_jni=set()
 for q in manifest['qualifiedAbis']:
  for native in q['native']:
   name='jni/'+q['abi']+'/'+native['file'];expected_jni.add(name);data=jar.read(name)
   require(len(data)==native['bytes'] and hashlib.sha256(data).hexdigest()==native['sha256'],'Native member mismatch: '+name)
 require({n for n in jar.namelist() if n.startswith('jni/') and not n.endswith('/')}==expected_jni,'Unexpected JNI members')

assets=source/'src/main/assets';asset_manifest=assets/'local-speech/v1/manifest.json';regular(asset_manifest)
model_bytes=asset_manifest.read_bytes();model_digest=hashlib.sha256(model_bytes).hexdigest();model=json.loads(model_bytes);require(model.get('format')=='eliza-local-speech-v1','Unsupported asset manifest format');expected={'local-speech/v1/manifest.json'};model_hashes={'local-speech/v1/manifest.json':model_digest}
for entry in model['files']:
 name=entry['path'];parts=Path(name).parts
 require(name and not Path(name).is_absolute() and '..' not in parts and Path(name).as_posix()==name,'Invalid model path')
 rel='local-speech/v1/'+name;require(rel not in expected,'Duplicate model entry');expected.add(rel);model_hashes[rel]=entry['sha256']
 file=assets/rel;regular(file);require(file.stat().st_size==entry['bytes'] and sha(file)==entry['sha256'],'Model/notice mismatch: '+name)
require(members(assets)==expected,'Unlisted or missing model/notice files')
# Freeze verified source hashes, then require destination readback; source mutation cannot silently succeed.
copy_files={'runtime-manifest.json':runtime_digest,'libs/'+archive.name:manifest['aarSha256']}
copy_files.update({'src/main/assets/'+name:digest for name,digest in model_hashes.items()})
for folder,names in [('libs',{archive.name}),('src/main/assets',expected)]:
 target=module/folder
 if target.exists():require(members(target)<=names,'Unowned destination files refused: '+folder)
for name,digest in copy_files.items():
 target=module/name
 for parent in target.relative_to(module).parents:require(not (module/parent).is_symlink(),'Destination symlink parent refused')
 require(not target.is_symlink(),'Destination symlink refused')
# No destination changes occur before all validation above completes.
for name,digest in copy_files.items():
 target=module/name;regular(source/name);require(sha(source/name)==digest,'Source changed after validation: '+name);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/name,target)
 require(sha(target)==digest,'Installed readback mismatch: '+name)
if a.test_assets:
 # Test fixtures are optional and distinct from the qualified shipping bundle.
 fixture=b/'source/android/app/src/androidTest/assets/speech-fixture';target=Path(a.test_assets).resolve()/'speech-fixture'
 names=members(fixture)
 extras={}
 if target.exists():extras={name:sha(target/name) for name in members(target)-names}
 # Extra regular consumer test fixtures are not owned by this installer.
 for name in names:
  dest=target/name;dest.parent.mkdir(parents=True,exist_ok=True);require(not dest.is_symlink(),'Test fixture symlink refused');digest=sha(fixture/name);shutil.copyfile(fixture/name,dest);require(sha(dest)==digest,'Fixture readback mismatch')
 for name,digest in extras.items():require(sha(target/name)==digest,'Unowned test fixture changed')
print('Validated and installed exact runtime/model/notice bytes; native acceptance remains separate')
