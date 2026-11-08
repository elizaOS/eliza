import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
test('local speech readiness reports each part and a stable reason',()=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'eliza-speech-readiness-'));
 const java=name=>process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',name):name;
 try{
  execFileSync(java('javac'),['--release','17','-d',output,path.join(here,'../src/main/java/ai/eliza/voice/LocalSpeechReadiness.java'),path.join(here,'readiness/LocalSpeechReadinessTest.java')],{timeout:60000,stdio:'pipe'});
  assert.match(execFileSync(java('java'),['-cp',output,'ai.eliza.voice.LocalSpeechReadinessTest'],{timeout:60000,encoding:'utf8'}),/^PASS local speech readiness by part/);
 }finally{fs.rmSync(output,{recursive:true,force:true});}
});
