import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildConsumerAndroidRuntime } from "./consumer-android-runtime.mjs";

test("runtime orchestration admits pinned source, stages bytes and rejects mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-runtime-"));
  try {
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    const put = (p, s) => {
      fs.mkdirSync(path.dirname(path.join(source, p)), { recursive: true });
      fs.writeFileSync(path.join(source, p), s);
    };
    put("packages/agent/src/bin.ts", "");
    put("bun.lock", "fixture");
    put(".gitignore", "packages/agent/dist-mobile/\n");
    put(
      "packages/agent/scripts/build-mobile-bundle.ts",
      `import fs from 'node:fs';fs.mkdirSync('packages/agent/dist-mobile',{recursive:true});fs.writeFileSync('packages/agent/dist-mobile/agent-bundle.js','fixture bundle');`,
    );
    put(
      "packages/app/scripts/lib/stage-android-agent.ts",
      `import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';export function stageAndroidAgentRuntime({androidDir}){const main=path.join(androidDir,'app/src/main');const files=[];const b=Buffer.alloc(64);b.writeUInt32BE(0x7f454c46);b[4]=2;b[5]=1;b.writeUInt16LE(183,18);for(const n of ['libeliza_bun.so','libeliza_ld_musl_aarch64.so','libeliza_ld_musl_aarch64_real.so','libeliza_stdcpp.so','libeliza_gcc_s.so','libsigsys-handler.so']){const p=path.join(main,'jniLibs/arm64-v8a',n);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b);files.push({path:'lib/arm64-v8a/'+n,size_bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}const dest=path.join(main,'assets/agent');fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'android-agent-runtime-provenance.json'),JSON.stringify({schema:'eliza.android_agent_runtime_provenance.v1',files}));}`,
    );
    const git = (...args) =>
      execFileSync("git", ["-C", source, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const expectedCommit = git("rev-parse", "HEAD"),
      skillsDirectory = path.join(root, "skills");
    fs.mkdirSync(skillsDirectory);
    fs.writeFileSync(path.join(skillsDirectory, "policy.md"), "consumer");
    const options = { source, expectedCommit, skillsDirectory };
    const link = path.join(root, "output-link");
    fs.symlinkSync(root, link, "dir");
    const { provenance } = buildConsumerAndroidRuntime({
      ...options,
      output: path.join(link, "good"),
      stageGateway: () => ({ host: "fixture" }),
    });
    assert.equal(provenance.commit, expectedCommit);
    assert.deepEqual(provenance.gatewayHashes, { host: "fixture" });
    assert.equal(provenance.target, "arm64-v8a");
    assert.throws(
      () =>
        buildConsumerAndroidRuntime({
          ...options,
          output: path.join(link, "good"),
          stageGateway: () => ({}),
        }),
      /EEXIST/,
    );
    assert.throws(
      () =>
        buildConsumerAndroidRuntime({
          ...options,
          output: path.join(root, "tampered"),
          stageGateway: (output) => {
            fs.writeFileSync(
              path.join(
                output,
                "android/app/src/main/jniLibs/arm64-v8a/libeliza_bun.so",
              ),
              "changed",
            );
            return {};
          },
        }),
      /integrity failed/,
    );
    assert.throws(
      () =>
        buildConsumerAndroidRuntime({
          ...options,
          output: path.join(root, "untracked"),
          stageGateway: () => {
            fs.writeFileSync(path.join(source, "unexpected.txt"), "changed");
            return {};
          },
        }),
      /Source changed/,
    );
    fs.rmSync(path.join(source, "unexpected.txt"));
    assert.throws(
      () =>
        buildConsumerAndroidRuntime({
          ...options,
          output: path.join(root, "changed"),
          stageGateway: () => {
            fs.appendFileSync(path.join(source, "bun.lock"), "changed");
            return {};
          },
        }),
      /Source changed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
