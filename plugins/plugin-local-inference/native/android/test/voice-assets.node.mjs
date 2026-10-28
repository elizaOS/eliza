import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

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
