/** Real ACP subprocess cancellation and independent spawn environments; no LLM or parent-agent reasoning. */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { NativeAcpClient } from "../../src/services/acp-native-transport.js";

const peer = String.raw`
import { createInterface } from 'node:readline';
import { writeFileSync, renameSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
writeFileSync('identity.json', JSON.stringify({pid:process.pid,cwd:process.cwd(),scope:process.env.FIXTURE_SCOPE,tokenA:process.env.FIXTURE_TOKEN_A,tokenB:process.env.FIXTURE_TOKEN_B}));
let active, timer, count=0;
const lines=createInterface({input:process.stdin});
lines.on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 else if(m.method==='session/new') send({jsonrpc:'2.0',id:m.id,result:{sessionId:'session'}});
 else if(m.method==='session/prompt') {
  if(m.params.prompt[0].text==='crash') process.exit(7);
  active=m.id;
  timer=setInterval(()=>{writeFileSync('progress.tmp',JSON.stringify({count:++count}));renameSync('progress.tmp','progress.json');},20);
 }
 else if(m.method==='session/cancel') {
  clearInterval(timer);
  writeFileSync('cancel.json',JSON.stringify({notification:m.id===undefined,sessionId:m.params.sessionId,count}));
  send({jsonrpc:'2.0',id:active,result:{stopReason:'cancelled'}});
 }
 else if(m.method==='session/close') send({jsonrpc:'2.0',id:m.id,result:{}});
});
lines.on('close',()=>{clearInterval(timer);process.exit(0);});
`;

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("ACP child did not reach the expected observable state");
}
async function progress(cwd: string): Promise<number> {
  try {
    return Number((await json(join(cwd, "progress.json"))).count);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

test("cancel settles the original prompt and leaves the other real child running", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "acp-process-lifecycle-")),
  );
  const script = join(root, "peer.mjs");
  await writeFile(script, peer);
  const clients: NativeAcpClient[] = [];
  const prompts: Promise<unknown>[] = [];
  try {
    for (const scope of ["A", "B"]) {
      const cwd = join(root, scope);
      await mkdir(cwd);
      const client = new NativeAcpClient({
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        cwd,
        approvalPreset: "readonly",
        timeoutMs: 10_000,
        env: {
          PATH: dirname(process.execPath),
          FIXTURE_SCOPE: scope,
          [`FIXTURE_TOKEN_${scope}`]: `fixture-${scope}`,
        },
      });
      clients.push(client);
      await client.start();
      const session = await client.createSession(cwd);
      const prompt = client.prompt(session.sessionId, "hold");
      // Observe rejection immediately, including failure during setup/cleanup.
      prompts.push(
        prompt.then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      );
    }
    const a = join(root, "A"),
      b = join(root, "B");
    await waitFor(
      async () => (await progress(a)) > 0 && (await progress(b)) > 0,
    );
    const identityA = await json(join(a, "identity.json"));
    const identityB = await json(join(b, "identity.json"));
    expect(identityA).toMatchObject({
      scope: "A",
      tokenA: "fixture-A",
      cwd: a,
    });
    expect(identityB).toMatchObject({
      scope: "B",
      tokenB: "fixture-B",
      cwd: b,
    });
    expect(identityA.tokenB).toBeUndefined();
    expect(identityB.tokenA).toBeUndefined();
    expect(identityA.pid).not.toBe(identityB.pid);
    expect(await clients[0].cancel("session")).toEqual({
      stopReason: "cancelled",
    });
    expect(await prompts[0]).toEqual({ value: { stopReason: "cancelled" } });
    const receipt = await json(join(a, "cancel.json"));
    expect(receipt.notification).toBe(true);
    const otherCount = await progress(b);
    await waitFor(async () => (await progress(b)) > otherCount + 2);
    expect(await progress(a)).toBe(receipt.count);
    expect(await clients[1].cancel("session")).toEqual({
      stopReason: "cancelled",
    });
    await Promise.all(clients.map((client) => client.close()));
    for (const identity of [identityA, identityB]) {
      expect(() => process.kill(Number(identity.pid), 0)).toThrow();
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled(prompts);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("an actual child crash rejects its pending prompt instead of fabricating completion", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "acp-process-crash-")),
  );
  const script = join(root, "peer.mjs");
  await writeFile(script, peer);
  const client = new NativeAcpClient({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    cwd: root,
    approvalPreset: "readonly",
    timeoutMs: 5_000,
    env: { PATH: dirname(process.execPath) },
  });
  try {
    await client.start();
    const session = await client.createSession(root);
    await expect(client.prompt(session.sessionId, "crash")).rejects.toThrow(
      /exited with code 7/,
    );
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
