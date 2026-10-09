#!/usr/bin/env python3
"""Assemble both separately qualified ABI builds into the staged module, never active source."""
from pathlib import Path
import hashlib,json,zipfile,shutil
b=Path(__file__).resolve().parent;module=b/'source/android/local-speech';out=module/'libs/sherpa-onnx-1.13.8-no-espeak.aar';out.parent.mkdir(parents=True,exist_ok=True)
qualified=[];entries={}
for abi in ['arm64-v8a','x86_64']:
 q=json.loads((b/('build-'+abi)/'qualification.json').read_text());archive=b/('sherpa-onnx-1.13.8-no-espeak-'+abi+'.aar')
 assert q['noEspeakSources'] and q['noEspeakSymbols'] and hashlib.sha256(archive.read_bytes()).hexdigest()==q['aarSha256']
 qualified.append(q)
 with zipfile.ZipFile(archive) as z:
  for name in z.namelist():
   data=z.read(name)
   if name in entries:assert entries[name]==data
   entries[name]=data
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for name,data in sorted(entries.items()):z.writestr(name,data)
(module/'runtime-manifest.json').write_text(json.dumps({'noEspeak':True,'aarSha256':hashlib.sha256(out.read_bytes()).hexdigest(),'qualifiedAbis':qualified},indent=2)+'\n')
print(out)
# This generates local build inputs. Commit acquisition/build scripts + manifests, not model binaries.
assets=b/'assets-ready/local-speech/v1'
manifest=json.loads((assets/'manifest.json').read_text())
for item in manifest['files']:
 source=assets/item['path'];assert source.stat().st_size==item['bytes'] and hashlib.sha256(source.read_bytes()).hexdigest()==item['sha256']
shutil.copytree(assets,module/'src/main/assets/local-speech/v1',dirs_exist_ok=True)
shutil.copytree(b/'assets-ready/androidTest/speech-fixture',b/'source/android/app/src/androidTest/assets/speech-fixture',dirs_exist_ok=True)
print('Verified model/notice assets and human-speech fixture staged for Android merge')
