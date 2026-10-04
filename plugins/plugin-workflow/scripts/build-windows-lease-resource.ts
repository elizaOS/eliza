import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const helper=join(import.meta.dir,'windows-lease');
// Resolve built-in cmdlets from the trusted PowerShell installation; restricted workers
// must not depend on environment-driven module discovery before the admission deadline.
const builtinImports="Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop\nImport-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop\n";
const script=builtinImports+"Add-Type -TypeDefinition @'\n"+readFileSync(join(helper,'WindowsLeaseNative.cs'),'utf8')+"\n'@\n"+readFileSync(join(helper,'windows-worker-lease.ps1'),'utf8');
const raw='export const windowsWorkerLeaseScript = '+JSON.stringify(script)+';\n';
const destination=join(import.meta.dir,'../src/services/windows-worker-lease-resource.ts');
const formatted=spawnSync(process.execPath,[createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome'),'format','--stdin-file-path',destination],{cwd:join(import.meta.dir,'..'),input:raw,encoding:'utf8',maxBuffer:8*1024*1024,timeout:30000});
if(formatted.error)throw formatted.error;
if(formatted.status!==0)throw Error('Windows resource formatting failed: '+formatted.stderr);
const output=formatted.stdout;
if(process.argv.includes('--check')){if(readFileSync(destination,'utf8')!==output)throw Error('Windows lease resource stale');}else writeFileSync(destination,output);
