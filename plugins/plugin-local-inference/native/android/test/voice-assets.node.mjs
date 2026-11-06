import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {voiceProductInputs,verifyVoiceProductBundle} from '../voice-product-inputs.mjs';
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
   'android/content/res/AssetManager.java':'package android.content.res; public final class AssetManager {private final java.io.File root;public AssetManager(java.io.File root){this.root=root;}public java.io.InputStream open(String p)throws java.io.IOException{return new java.io.FileInputStream(new java.io.File(root,p));}public String[] list(String p)throws java.io.IOException{return new java.io.File(root,p).list();}}',
   'android/content/Context.java':'package android.content; public final class Context {private final java.io.File files;private final android.content.res.AssetManager assets;public final android.content.pm.ApplicationInfo info=new android.content.pm.ApplicationInfo();public Context(java.io.File assets,java.io.File files){this.assets=new android.content.res.AssetManager(assets);this.files=files;}public java.io.File getFilesDir(){return files;}public android.content.res.AssetManager getAssets(){return assets;}public String getPackageName(){return "fixture.app";}public android.content.pm.PackageManager getPackageManager(){return new android.content.pm.PackageManager(info);}}',
  };
  const files=Object.entries(sources).map(([name,contents])=>{const p=path.join(output,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,contents);return p;});
  execFileSync(java('javac'),['--release','17','-cp',jar,'-d',output,...files,path.join(here,'../src/main/java/ai/eliza/voice/VoiceBundleAssets.java'),path.join(here,'assets/VoiceBundleAssetsTest.java')],{timeout:60000,stdio:'pipe'});
  assert.match(execFileSync(java('java'),['-cp',output+path.delimiter+jar,'ai.eliza.voice.VoiceBundleAssetsTest',path.join(output,'data')],{timeout:60000,encoding:'utf8'}),/^PASS shared voice asset installation/);
 }finally{fs.rmSync(output,{recursive:true,force:true});}
});


test('producer and Gradle contract keep explicit English bundles separate from the pinned bilingual default',()=>{
 const inputs=JSON.parse(fs.readFileSync(path.join(here,'../inputs.json'),'utf8'));
 const english=voiceProductInputs(inputs,['en']), bilingual=voiceProductInputs(inputs);
 assert.deepEqual(english.languages,['en']);assert.deepEqual(bilingual.languages,['en','es']);
 const make=product=>{
  const files=[inputs.paradee,inputs.lexicon,inputs.asr,inputs.vad,...(product.spanish?[inputs.spanish]:[])].map(({path,bytes,sha256})=>({path,bytes,sha256}));
  for(const relative of product.espeakData) files.push({path:`tts/paradee/espeak-ng-data/${relative}`,bytes:1,sha256:'0'.repeat(64)});
  const manifest={format:'eliza-paradee-voice-v2',model:inputs.paradee.path,lexicon:inputs.lexicon.path,espeakDir:'tts/paradee',files,...(product.spanish?{voices:{es:inputs.spanish.path}}:{})};
  const record={productLanguages:product.languages,files:files.map(row=>({...row,path:'assets/paradee-voice/v1/'+row.path}))};
  return {manifest,record};
 };
 for(const product of [english,bilingual]){const {record,manifest}=make(product);assert.deepEqual(verifyVoiceProductBundle(inputs,product,record,manifest),product);}
 const {record,manifest}=make(english);
 assert.throws(()=>verifyVoiceProductBundle(inputs,bilingual,record,manifest),/selection differs/);
 delete record.productLanguages;assert.throws(()=>verifyVoiceProductBundle(inputs,english,record,manifest),/selection differs/);
 const legacy=make(bilingual);delete legacy.record.productLanguages;verifyVoiceProductBundle(inputs,bilingual,legacy.record,legacy.manifest);
 for(const languages of [[],['es'],['en','en'],['en','fr']])assert.throws(()=>voiceProductInputs(inputs,languages));
 assert.throws(()=>voiceProductInputs({...inputs,spanish:{...inputs.spanish,enabled:false}},['en','es']),/not enabled/);
 for(const mutate of [
  f=>{f.manifest.voices={es:inputs.spanish.path};},
  f=>{f.record.productLanguages=['en','es'];},
  f=>{f.record.files[0].sha256='0'.repeat(64);},
  f=>{f.manifest.files[0].sha256='0'.repeat(64);},
  f=>{f.manifest.format='eliza-paradee-voice-v3';},
  f=>{const row={path:inputs.spanish.path,bytes:inputs.spanish.bytes,sha256:inputs.spanish.sha256};f.manifest.files.push(row);f.record.files.push({...row,path:'assets/paradee-voice/v1/'+row.path});},
  f=>{const row={path:'asr/extra-es.gguf',bytes:1,sha256:'0'.repeat(64)};f.manifest.files.push(row);f.record.files.push({...row,path:'assets/paradee-voice/v1/'+row.path});},
  f=>{const row={path:'tts/paradee/espeak-ng-data/es_dict',bytes:1,sha256:'0'.repeat(64)};f.manifest.files.push(row);f.record.files.push({...row,path:'assets/paradee-voice/v1/'+row.path});},
 ]){const f=make(english);mutate(f);assert.throws(()=>verifyVoiceProductBundle(inputs,english,f.record,f.manifest));}
 const badSpanish=make(bilingual);badSpanish.record.files.find(row=>row.path.endsWith(inputs.spanish.path)).sha256='0'.repeat(64);
 assert.throws(()=>verifyVoiceProductBundle(inputs,bilingual,badSpanish.record,badSpanish.manifest));
});
