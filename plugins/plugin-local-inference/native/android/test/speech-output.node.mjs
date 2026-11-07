import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const java=name=>process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',name):name;
test('synthesized lead-in silence is trimmed with a short pre-roll and later audio passes through',()=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'eliza-speech-trim-'));
 try{
  execFileSync(java('javac'),['--release','17','-d',output,path.join(here,'../src/main/java/ai/eliza/voice/SpeechLeadTrim.java'),path.join(here,'speech/SpeechLeadTrimTest.java')],{timeout:60000,stdio:'pipe'});
  assert.match(execFileSync(java('java'),['-cp',output,'ai.eliza.voice.SpeechLeadTrimTest'],{timeout:60000,encoding:'utf8'}),/^PASS speech lead trim/);
 }finally{fs.rmSync(output,{recursive:true,force:true});}
});
