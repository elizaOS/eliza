#!/usr/bin/env python3
"""Build a narrow immutable bundle in staging, excluding all eSpeak files and unused models."""
from pathlib import Path
import hashlib,json,shutil
b=Path(__file__).resolve().parent;out=b/'assets-ready/local-speech/v1';out.mkdir(parents=True,exist_ok=True)
files={
 'asr/encoder.onnx':b/'models/sherpa-onnx-whisper-tiny.en/tiny.en-encoder.int8.onnx',
 'asr/decoder.onnx':b/'models/sherpa-onnx-whisper-tiny.en/tiny.en-decoder.int8.onnx',
 'asr/tokens.txt':b/'models/sherpa-onnx-whisper-tiny.en/tiny.en-tokens.txt',
 'tts/model.onnx':b/'models/vits-piper-en_US-ljspeech-medium-int8/en_US-ljspeech-medium.onnx',
 'tts/tokens.txt':b/'models/vits-piper-en_US-ljspeech-medium-int8/tokens.txt',
 'tts/lexicon.txt':b/'generated/lexicon.txt',
 'notices/ONNXRuntime-LICENSE':b/'reference/onnxruntime-LICENSE',
 'notices/CMUdict-LICENSE':b/'reference/cmudict-LICENSE',
 'notices/Whisper-LICENSE':b/'reference/whisper-LICENSE',
 'notices/Piper-LJSpeech-MODEL_CARD':b/'reference/ljspeech-MODEL_CARD',
 'notices/Piper-voices-README.md':b/'reference/piper-voices-README.md',
 'notices/Sherpa-LICENSE':b/'native-source/sherpa-onnx-1.13.8/LICENSE',
}
notice_dir=b/'reference/native-dependency-notices';notice_dir.mkdir(parents=True,exist_ok=True)
for dep in sorted((b/'build-arm64-v8a/_deps').glob('*-src')):
 for notice in dep.iterdir():
  if notice.is_file() and (notice.name.upper().startswith('LICENSE') or notice.name.upper().startswith('COPYING')):shutil.copy2(notice,notice_dir/(dep.name+'-'+notice.name))
extra=b/'build-arm64-v8a/_deps/kissfft-src/LICENSES/BSD-3-Clause'
if extra.exists():shutil.copy2(extra,notice_dir/'kissfft-BSD-3-Clause')
if not list(notice_dir.iterdir()):raise RuntimeError('Build native dependencies before preparing notices')
for notice in notice_dir.iterdir():
 files['notices/native/'+notice.name]=notice
entries=[]
for name,source in files.items():
 target=out/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target);data=target.read_bytes();entries.append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
manifest={'format':'eliza-local-speech-v1','execution':'device-cpu','languages':['en'],'asr':'Whisper tiny.en int8','tts':'Piper LJSpeech medium int8; CMUdict IPA lexicon; no eSpeak','files':entries}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
fixture=b/'assets-ready/androidTest/speech-fixture';fixture.mkdir(parents=True,exist_ok=True);shutil.copy2(b/'models/sherpa-onnx-whisper-tiny.en/test_wavs/0.wav',fixture/'0.wav')
print(json.dumps({'modelBundleBytes':sum(x['bytes'] for x in entries),'manifestSha256':hashlib.sha256((out/'manifest.json').read_bytes()).hexdigest(),'fixtureBytes':(fixture/'0.wav').stat().st_size},indent=2))
