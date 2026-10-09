import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, SourceTextModule } from "node:vm";

// Test harness supplies standard Web APIs only. The consumer cannot see Node globals.
const context=createContext({crypto,performance,AbortController,DOMException});
const module=new SourceTextModule(readFileSync(process.argv[2],"utf8"),{context});
await module.link(()=>{throw Error("Browser bundle contains an unresolved import");});
await module.evaluate({timeout:5000});
assert.deepEqual(JSON.parse(JSON.stringify(context.batchVoicePackageReceipt)),{captures:1,transcribes:1,sends:1,speeches:1,cancels:1});
assert.equal(context.process,undefined);assert.equal(context.Buffer,undefined);assert.equal(context.require,undefined);
