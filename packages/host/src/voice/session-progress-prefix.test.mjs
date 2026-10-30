import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('./session.ts',import.meta.url),'utf8');
const start=source.indexOf('const SENTENCE_END_RE ='),end=source.indexOf('/** Conservative residual-echo filter',start);
assert.ok(start>=0&&end>start);
const strip=new Function(stripTypeScriptTypes(source.slice(start,end),{mode:'transform'})+';return withoutRepeatedProgressCue;')();
const cues=['Opening Calendar for you.','Still working on that.'];
for(const [name,reply,expected]of[
 ['two leading cues','Opening Calendar for you. Still working on that. New content.','New content.'],
 ['only cues','Opening Calendar for you. Still working on that.',''],
 ['negation','Not Opening Calendar for you. Still working on that. New content.','Not Opening Calendar for you. Still working on that. New content.'],
 ['new first sentence','New content. Opening Calendar for you. Still working on that.','New content. Opening Calendar for you. Still working on that.'],
 ['stop at new content','Opening Calendar for you. New content. Still working on that.','New content. Still working on that.'],
 ['normalization','opening calendar now! STILL WORKING ON THAT! New content.','New content.'],
])test(name,()=>assert.equal(strip(reply,cues),expected));
