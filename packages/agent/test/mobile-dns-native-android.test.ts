import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const modulePath = fileURLToPath(
  new URL("../src/runtime/mobile-dns.ts", import.meta.url),
);

test("native Android keeps platform DNS and native fetch identities untouched", () => {
  const script = `import dns from 'node:dns';const lookup=dns.lookup,promiseLookup=dns.promises.lookup,nativeFetch=globalThis.fetch;let calls=0;dns.setServers=()=>{calls++;throw Error('native resolver override forbidden')};Object.defineProperty(process,'platform',{value:'android'});process.env.ELIZA_PLATFORM='android';process.env.ELIZA_MOBILE_DNS_SERVERS='invalid-config-must-not-be-read';const {configureMobileDnsIfNeeded}=await import(${JSON.stringify(modulePath)});configureMobileDnsIfNeeded();process.stdout.write(JSON.stringify({calls,lookupSame:dns.lookup===lookup,promiseLookupSame:dns.promises.lookup===promiseLookup,fetchSame:globalThis.fetch===nativeFetch}));`;
  const result = spawnSync(
    "bun",
    ["--no-env-file", "--conditions=eliza-source", "--eval", script],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    calls: 0,
    lookupSame: true,
    promiseLookupSame: true,
    fetchSame: true,
  });
});
