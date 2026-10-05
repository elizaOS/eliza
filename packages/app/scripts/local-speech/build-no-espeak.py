#!/usr/bin/env python3
"""Root-owned bounded NDK build. Only writes inside this staging directory."""
from pathlib import Path
import argparse,hashlib,json,os,subprocess,zipfile,re
b=Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--abi',choices=['arm64-v8a','x86_64'],required=True);p.add_argument('--ndk',required=True);p.add_argument('--jobs',type=int,default=2);a=p.parse_args();assert 1<=a.jobs<=4
source=b/'native-source/sherpa-onnx-1.13.8';ndk=Path(a.ndk).resolve();build=b/('build-'+a.abi);build.mkdir(exist_ok=True)
assert hashlib.sha256((b/'downloads/sherpa-source-v1.13.8.tar.gz').read_bytes()).hexdigest()=='b0374cc56dbc186d442ae73d5de743bb092470b640c4c50ce7b029044c0c4fa8'
stock=b/'downloads/sherpa-onnx-1.13.8.aar';assert hashlib.sha256(stock.read_bytes()).hexdigest()=='633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96'
manifest=json.loads((b/'sherpa-no-espeak-manifest.json').read_text())
if all(hashlib.sha256((source/e['path']).read_bytes()).hexdigest()==e['before'] for e in manifest):subprocess.run(['git','apply',str(b/'sherpa-no-espeak.patch')],cwd=source,check=True)
for e in manifest:assert hashlib.sha256((source/e['path']).read_bytes()).hexdigest()==e['after'],e['path']
ort=b/'onnxruntime'/a.abi;ort.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(stock) as z:(ort/'libonnxruntime.so').write_bytes(z.read('jni/'+a.abi+'/libonnxruntime.so'))
env=dict(os.environ,SHERPA_ONNXRUNTIME_LIB_DIR=str(ort),SHERPA_ONNXRUNTIME_INCLUDE_DIR=str(b/'reference/onnxruntime-headers'))
flags=['-DCMAKE_BUILD_TYPE=Release','-DCMAKE_EXPORT_COMPILE_COMMANDS=ON','-DCMAKE_SHARED_LINKER_FLAGS=-Wl,--threads=2,--thinlto-jobs=2','-DBUILD_SHARED_LIBS=ON','-DSHERPA_ONNX_ENABLE_TTS=ON','-DSHERPA_ONNX_ENABLE_ESPEAK=OFF','-DSHERPA_ONNX_ENABLE_JNI=ON','-DSHERPA_ONNX_ENABLE_C_API=OFF','-DSHERPA_ONNX_ENABLE_BINARY=OFF','-DSHERPA_ONNX_ENABLE_TESTS=OFF','-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF','-DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF','-DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF','-DSHERPA_ONNX_ENABLE_PYTHON=OFF','-DSHERPA_ONNX_ENABLE_GPU=OFF','-DANDROID_ABI='+a.abi,'-DANDROID_PLATFORM=android-26','-DANDROID_STL=c++_static','-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON','-DCMAKE_TOOLCHAIN_FILE='+str(ndk/'build/cmake/android.toolchain.cmake')]
with (build/'build.log').open('w') as log:
 for command in [['cmake','-S',str(source),'-B',str(build),*flags],['cmake','--build',str(build),'--target','sherpa-onnx-jni','--parallel',str(a.jobs)]]:
  subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
commands=json.loads((build/'compile_commands.json').read_text());assert not any(any(x in item['file'] for x in ['piper-phonemize-lexicon.cc','kokoro-multi-lang-lexicon.cc','matcha-tts-lexicon.cc','espeak-ng/']) for item in commands)
tools=next((ndk/'toolchains/llvm/prebuilt').glob('*/bin'));core=next(build.rglob('libsherpa-onnx-core.a'));symbols=subprocess.check_output([str(tools/'llvm-nm'),'--defined-only',str(core)],text=True);assert not re.search(r'espeak_|phonemize_eSpeak|InitEspeak',symbols)
shared=next(build.rglob('libsherpa-onnx-jni.so'));native={shared.name:shared,'libonnxruntime.so':ort/'libonnxruntime.so'}
checks=[]
for name,file in native.items():
 elf=subprocess.check_output([str(tools/'llvm-readelf'),'-lW',str(file)],text=True);loads=[line for line in elf.splitlines() if line.strip().startswith('LOAD')];assert loads and all(int(line.split()[-1],16)>=16384 for line in loads),(name,loads)
 deps=subprocess.check_output([str(tools/'llvm-readelf'),'-d',str(file)],text=True);assert not re.search(r'espeak|piper',deps,re.I)
 checks.append({'file':name,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'pageAlignment':16384})
# Per-ABI artifacts are separate; merge only qualified ABI libraries in a later step.
out=b/('sherpa-onnx-1.13.8-no-espeak-'+a.abi+'.aar')
with zipfile.ZipFile(stock) as original,zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as result:
 for info in original.infolist():
  if not info.filename.startswith('jni/') and not info.is_dir():result.writestr(info.filename,original.read(info.filename))
 for name,file in native.items():result.writestr('jni/'+a.abi+'/'+name,file.read_bytes())
(build/'qualification.json').write_text(json.dumps({'abi':a.abi,'sourceArchiveSha256':'b0374cc56dbc186d442ae73d5de743bb092470b640c4c50ce7b029044c0c4fa8','patchSha256':hashlib.sha256((b/'sherpa-no-espeak.patch').read_bytes()).hexdigest(),'noEspeakSources':True,'noEspeakSymbols':True,'native':checks,'aarSha256':hashlib.sha256(out.read_bytes()).hexdigest(),'deviceExecuted':False},indent=2)+'\n')
print(out)
