import { execFileSync } from "node:child_process";
import path from "node:path";
import { it } from "vitest";

it("normal packages support an external renderer voice consumer without private aliases",()=>{
  const root=path.resolve(import.meta.dirname,"../../../../..");
  execFileSync(process.execPath,["packages/ui/scripts/verify-batch-voice-package.ts"],{cwd:root,stdio:"pipe",timeout:180000});
},180000);
