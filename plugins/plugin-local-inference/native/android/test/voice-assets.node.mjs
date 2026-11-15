import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  verifyVoiceProductBundle,
  voiceProductInputs,
} from '../voice-product-inputs.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
test('shared voice assets install without loading an inference library',()=>{
 const cache=path.join(os.homedir(),'.gradle/caches/modules-2/files-2.1/org.json/json/20250517');
 const jar=process.env.ELIZA_JSON_JAR||(fs.existsSync(cache)?fs.readdirSync(cache).flatMap(d=>fs.readdirSync(path.join(cache,d)).filter(f=>f==='json-20250517.jar').map(f=>path.join(cache,d,f)))[0]:undefined);
 assert.ok(jar,'Set ELIZA_JSON_JAR to the existing org.json:json:20250517 dependency');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'eliza-voice-assets-'));
 const java=name=>process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',name):name;
 try{
  const sources={
   'android/os/Bundle.java':'package android.os; public final class Bundle extends java.util.HashMap<String,Object> {}',
   'android/content/pm/ApplicationInfo.java':'package android.content.pm; public final class ApplicationInfo {public android.os.Bundle metaData=new android.os.Bundle();}',
   'android/content/pm/PackageManager.java':'package android.content.pm; public final class PackageManager {public static final int GET_META_DATA=128;private final ApplicationInfo info;public PackageManager(ApplicationInfo info){this.info=info;}public ApplicationInfo getApplicationInfo(String name,int flags)throws NameNotFoundException{return info;}public static final class NameNotFoundException extends Exception{}}',
   'android/content/res/AssetManager.java':'package android.content.res; public final class AssetManager {private final java.io.File root;public final java.util.Map<String,Object[]> stored=new java.util.HashMap<>();public AssetManager(java.io.File root){this.root=root;}public java.io.InputStream open(String p)throws java.io.IOException{return new java.io.FileInputStream(new java.io.File(root,p));}public String[] list(String p)throws java.io.IOException{return new java.io.File(root,p).list();}public AssetFileDescriptor openFd(String p)throws java.io.IOException{Object[] at=stored.get(p);if(at==null)throw new java.io.FileNotFoundException("compressed "+p);return new AssetFileDescriptor(android.os.ParcelFileDescriptor.open((String)at[0]),(Long)at[1],new java.io.File(root,p).length());}}',
   'android/content/res/AssetFileDescriptor.java':'package android.content.res; public final class AssetFileDescriptor implements java.io.Closeable {private final android.os.ParcelFileDescriptor fd;private final long offset,length;public AssetFileDescriptor(android.os.ParcelFileDescriptor fd,long offset,long length){this.fd=fd;this.offset=offset;this.length=length;}public android.os.ParcelFileDescriptor getParcelFileDescriptor(){return fd;}public long getStartOffset(){return offset;}public long getLength(){return length;}public void close(){android.os.ParcelFileDescriptor.OPEN.remove(fd.getFd());}}',
   'android/os/ParcelFileDescriptor.java':'package android.os; public final class ParcelFileDescriptor {public static final java.util.Map<Integer,String> OPEN=new java.util.HashMap<>();private static int next=40;private final int fd;private ParcelFileDescriptor(int fd){this.fd=fd;}public static ParcelFileDescriptor open(String path){OPEN.put(next,path);return new ParcelFileDescriptor(next++);}public int getFd(){return fd;}}',
   'android/system/ErrnoException.java':'package android.system; public final class ErrnoException extends Exception {public ErrnoException(String m){super(m);}}',
   'android/system/Os.java':'package android.system; public final class Os {public static String readlink(String p)throws ErrnoException{String path=p.startsWith("/proc/self/fd/")?android.os.ParcelFileDescriptor.OPEN.get(Integer.parseInt(p.substring(14))):null;if(path==null)throw new ErrnoException(p);return path;}}',
   'android/content/Context.java':'package android.content; public final class Context {private final java.io.File files;private final android.content.res.AssetManager assets;public final android.content.pm.ApplicationInfo info=new android.content.pm.ApplicationInfo();public Context(java.io.File assets,java.io.File files){this.assets=new android.content.res.AssetManager(assets);this.files=files;}public java.io.File getFilesDir(){return files;}public android.content.res.AssetManager getAssets(){return assets;}public String getPackageName(){return "fixture.app";}public android.content.pm.PackageManager getPackageManager(){return new android.content.pm.PackageManager(info);}}',
  };
  const files=Object.entries(sources).map(([name,contents])=>{const p=path.join(output,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,contents);return p;});
  execFileSync(java('javac'),['--release','17','-cp',jar,'-d',output,...files,path.join(here,'../src/main/java/ai/eliza/voice/VoiceBundleAssets.java'),path.join(here,'assets/VoiceBundleAssetsTest.java')],{timeout:60000,stdio:'pipe'});
  assert.match(execFileSync(java('java'),['-cp',output+path.delimiter+jar,'ai.eliza.voice.VoiceBundleAssetsTest',path.join(output,'data')],{timeout:60000,encoding:'utf8'}),/^PASS shared voice asset installation/);
 }finally{fs.rmSync(output,{recursive:true,force:true});}
});

test('producer and Gradle contract keep explicit English bundles separate from the pinned bilingual default', () => {
  const inputs = JSON.parse(fs.readFileSync(path.join(here, '../inputs.json'), 'utf8'));
  const prefix = 'assets/paradee-voice/v1/';
  const english = voiceProductInputs(inputs, ['en']);
  const bilingual = voiceProductInputs(inputs);
  assert.deepEqual(english.languages, ['en']);
  assert.deepEqual(bilingual.languages, ['en', 'es']);

  const fixture = (product) => {
    const files = [inputs.paradee, inputs.lexicon, inputs.asr, inputs.vad]
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    const manifest = {
      format: 'eliza-paradee-voice-v2', model: inputs.paradee.path,
      lexicon: inputs.lexicon.path, espeakDir: 'tts/paradee', files,
    };
    const record = {
      productLanguages: product.languages,
      files: files.map(row => ({ ...row, path: `${prefix}${row.path}` })),
    };
    const addAsset = (relative, bytes = 1, sha256 = '0'.repeat(64)) => {
      files.push({ path: relative, bytes, sha256 });
      record.files.push({ path: `${prefix}${relative}`, bytes, sha256 });
    };
    for (const relative of product.espeakData) addAsset(`tts/paradee/espeak-ng-data/${relative}`);
    if (product.spanish) {
      const { path, bytes, sha256, notices } = inputs.spanish;
      manifest.voices = { es: path };
      addAsset(path, bytes, sha256);
      for (const notice of notices) addAsset(`notices/delibes/${notice}`);
    }
    return { record, manifest, addAsset };
  };

  const verify = (product, { record, manifest }, pins = inputs) =>
    verifyVoiceProductBundle(pins, product, record, manifest);
  for (const product of [english, bilingual]) assert.deepEqual(verify(product, fixture(product)), product);
  assert.throws(() => verify(bilingual, fixture(english)), /selection differs/);
  const legacy = fixture(bilingual);
  delete legacy.record.productLanguages;
  assert.throws(() => verify(english, legacy), /selection differs/);
  verify(bilingual, legacy);

  for (const languages of [[], ['es'], ['en', 'en'], ['en', 'fr']]) {
    assert.throws(() => voiceProductInputs(inputs, languages));
  }
  const disabledInputs = { ...inputs, spanish: { ...inputs.spanish, enabled: false } };
  assert.throws(() => voiceProductInputs(disabledInputs, ['en', 'es']), /not enabled/);
  const defaultEnglish = voiceProductInputs(disabledInputs);
  // Legacy defaults copied Spanish eSpeak files even when the model was disabled.
  const legacyEnglish = fixture({ ...defaultEnglish, espeakData: inputs.espeak.data });
  delete legacyEnglish.record.productLanguages;
  verify(defaultEnglish, legacyEnglish, disabledInputs);

  for (const mutate of [
    ({ manifest }) => { manifest.voices = { es: inputs.spanish.path }; },
    ({ record }) => { record.productLanguages = ['en', 'es']; },
    ({ record }) => { record.files[0].sha256 = '0'.repeat(64); },
    ({ manifest }) => { manifest.files[0].sha256 = '0'.repeat(64); },
    ({ manifest }) => { manifest.format = 'eliza-paradee-voice-v3'; },
    ({ addAsset }) => addAsset(inputs.spanish.path, inputs.spanish.bytes, inputs.spanish.sha256),
    ({ addAsset }) => addAsset('asr/extra-es.gguf'),
  ]) {
    const bundle = fixture(english);
    mutate(bundle);
    assert.throws(() => verify(english, bundle));
  }

  const outsideBundle = fixture(english);
  outsideBundle.record.files.push({ path: 'assets/extra/unselected.gguf', bytes: 1, sha256: '0'.repeat(64) });
  assert.throws(() => verify(english, outsideBundle), /outside the voice bundle/);

  for (const dictionary of ['es_dict', 'fr_dict']) {
    const unselectedLanguage = fixture(english);
    unselectedLanguage.addAsset(`tts/paradee/espeak-ng-data/${dictionary}`);
    assert.throws(() => verify(english, unselectedLanguage), /Undeclared eSpeak data/);
  }

  const badSpanish = fixture(bilingual);
  badSpanish.record.files.find(row => row.path.endsWith(inputs.spanish.path)).sha256 = '0'.repeat(64);
  assert.throws(() => verify(bilingual, badSpanish));

  const missingNotice = fixture(bilingual);
  const notice = 'notices/delibes/LICENSE';
  missingNotice.manifest.files = missingNotice.manifest.files.filter(row => row.path !== notice);
  missingNotice.record.files = missingNotice.record.files.filter(row => row.path !== `${prefix}${notice}`);
  assert.throws(() => verify(bilingual, missingNotice), /Missing Spanish notice/);
});
