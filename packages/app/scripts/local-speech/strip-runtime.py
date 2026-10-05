#!/usr/bin/env python3
"""Strip only validated JNI debug data; preserve original native-build evidence."""
from pathlib import Path
import argparse,json,hashlib,zipfile,subprocess,shutil
b=Path(__file__).resolve().parent;p=argparse.ArgumentParser();p.add_argument('--abi',required=True,choices=['arm64-v8a','x86_64']);p.add_argument('--ndk',required=True);a=p.parse_args();build=b/('build-'+a.abi);q=build/'qualification.json';data=json.loads(q.read_text());archive=b/('sherpa-onnx-1.13.8-no-espeak-'+a.abi+'.aar');tools=next((Path(a.ndk)/'toolchains/llvm/prebuilt').glob('*/bin'))
assert hashlib.sha256(archive.read_bytes()).hexdigest()==data['aarSha256']
if data.get('debugSymbolsStripped'):print('Already stripped');raise SystemExit
shutil.copy2(q,build/'qualification.unstripped.json');shutil.copy2(archive,archive.with_suffix('.unstripped.aar'))
with zipfile.ZipFile(archive) as z:entries={name:z.read(name) for name in z.namelist()}
name='jni/'+a.abi+'/libsherpa-onnx-jni.so';packaged=build/'packaged/libsherpa-onnx-jni.so';packaged.parent.mkdir(exist_ok=True);packaged.write_bytes(entries[name]);subprocess.run([str(tools/'llvm-strip'),'--strip-unneeded',str(packaged)],check=True)
elf=subprocess.check_output([str(tools/'llvm-readelf'),'-lW',str(packaged)],text=True);loads=[line for line in elf.splitlines() if line.strip().startswith('LOAD')];assert loads and all(int(line.split()[-1],16)>=16384 for line in loads)
entries[name]=packaged.read_bytes()
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 for name,content in entries.items():z.writestr(name,content)
for native in data['native']:
 if native['file']=='libsherpa-onnx-jni.so':native['unstrippedSha256']=native['sha256'];native['unstrippedBytes']=native['bytes'];native['bytes']=packaged.stat().st_size;native['sha256']=hashlib.sha256(packaged.read_bytes()).hexdigest()
data['aarSha256']=hashlib.sha256(archive.read_bytes()).hexdigest();data['debugSymbolsStripped']=True;q.write_text(json.dumps(data,indent=2)+'\n');print(json.dumps(data,indent=2))
