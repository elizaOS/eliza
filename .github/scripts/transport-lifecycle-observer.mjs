/** Record owned diagnostic child lifetimes without command arguments or environment values. */
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';
const destination=`${process.env.RUNNER_TEMP}/transport-observation/lifecycle.jsonl`;
function record(event,fields={}) {appendFileSync(destination,JSON.stringify({event,pid:process.pid,parentPid:process.ppid,at:new Date().toISOString(),...fields})+'\n');}
record('node-start');
const spawn=cp.spawn;
cp.spawn=function(command,...rest){const child=spawn.call(this,command,...rest);record('spawn',{command:basename(String(command)),childPid:child.pid});child.once('exit',(code,signal)=>record('child-exit',{childPid:child.pid,code,signal}));return child;};
const spawnSync=cp.spawnSync;
cp.spawnSync=function(command,...rest){record('spawn-sync-start',{command:basename(String(command))});const child=spawnSync.call(this,command,...rest);record('spawn-sync-end',{childPid:child.pid,status:child.status,signal:child.signal});return child;};
process.once('exit',code=>record('node-exit',{code}));
syncBuiltinESMExports();
