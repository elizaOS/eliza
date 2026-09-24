/** Exercises the actual remote inspection/removal programs with a controlled Docker executable and explicit test-only boot-file shim. This unit harness does not prove a Linux host's identity or physical removal. */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCKER_RUNTIME_OBSERVATION_PROGRAM,
  DOCKER_RUNTIME_STOP_PROGRAM,
} from "./docker-runtime-observation";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const original = "a".repeat(64),
  replacement = "b".repeat(64);
const boot = "10000000-0000-4000-8000-000000000002";
const organizationId = "10000000-0000-4000-8000-000000000003",
  agentId = "10000000-0000-4000-8000-000000000004";
function container(id: string) {
  return {
    Id: id,
    Name: "/owned-container",
    Config: {
      Labels: {
        "ai.elizaos.managed-by": "eliza-cloud",
        "ai.elizaos.agent-id": agentId,
        "ai.elizaos.org-id": organizationId,
        "ai.elizaos.container-class": "user",
      },
    },
    State: { Running: true },
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eliza-exact-stop-unit-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  const state = join(root, "state.json");
  await writeFile(
    state,
    JSON.stringify({ containers: [container(original)], calls: [], unavailable: false }),
  );
  await writeFile(join(root, "boot"), boot);
  const python = (
    await new Response(Bun.spawn(["/usr/bin/which", "python3"], { stdout: "pipe" }).stdout).text()
  ).trim();
  await writeFile(
    join(root, "bin/docker"),
    `#!${python}\n` +
      String.raw`
import json, os, sys, re
path=os.environ['EXACT_STOP_UNIT_STATE']
with open(path) as f: state=json.load(f)
args=sys.argv[1:]
if args[:2] != ['--host','unix:///var/run/docker.sock']: raise RuntimeError('explicit_local_daemon_required')
args=args[2:]
if state['unavailable']: sys.exit(70)
if args[0]=='ps':
    query=args[-1]
    if query.startswith('id='): rows=[c for c in state['containers'] if c['Id']==query[3:]]
    elif query.startswith('name='): rows=[c for c in state['containers'] if re.fullmatch(query[5:],c['Name'])]
    else: raise RuntimeError('unsupported_query')
    print('\n'.join(c['Id'] for c in rows))
elif args[0]=='inspect':
    rows=[c for c in state['containers'] if c['Id']==args[-1]]
    if len(rows)!=1: sys.exit(71)
    print(json.dumps(rows[0]))
elif args[0] in ('stop','rm'):
    target=args[-1]
    if not re.fullmatch('[a-f0-9]{64}',target): raise RuntimeError('name_based_mutation_forbidden')
    state['calls'].append([args[0],target])
    if args[0]=='rm': state['containers']=[c for c in state['containers'] if c['Id']!=target]
    else:
        for c in state['containers']:
            if c['Id']==target: c['State']['Running']=False
    with open(path,'w') as f: json.dump(state,f)
else: raise RuntimeError('unsupported_command')
`,
    { mode: 0o700 },
  );
  const shim = `import builtins, os
real_open=builtins.open
def unit_open(path,*args,**kwargs):
    return real_open(os.environ['EXACT_STOP_UNIT_BOOT'] if path=='/proc/sys/kernel/random/boot_id' else path,*args,**kwargs)
builtins.open=unit_open
`;
  const request = {
    nodeIncarnation: boot,
    containerName: "owned-container",
    containerId: original,
    agentId,
    organizationId,
  };
  return {
    root,
    async write(value: object) {
      await writeFile(state, JSON.stringify(value));
    },
    async read() {
      return JSON.parse(await readFile(state, "utf8"));
    },
    async run(program: string) {
      const child = Bun.spawn([python, "-c", shim + program], {
        env: {
          ...process.env,
          PATH: join(root, "bin") + ":" + process.env.PATH,
          EXACT_STOP_UNIT_STATE: state,
          EXACT_STOP_UNIT_BOOT: join(root, "boot"),
        },
        stdin: new TextEncoder().encode(JSON.stringify(request)),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
  };
}
test("a replacement appearing after observation is never stopped by name", async () => {
  const f = await fixture();
  const seen = await f.run(DOCKER_RUNTIME_OBSERVATION_PROGRAM);
  expect(seen.code).toBe(0);
  expect(JSON.parse(seen.stdout).containerId).toBe(original);
  await f.write({ containers: [container(replacement)], calls: [], unavailable: false });
  const stopped = await f.run(DOCKER_RUNTIME_STOP_PROGRAM);
  expect(stopped.code).not.toBe(0);
  expect(stopped.stderr).toContain("same_name_replacement");
  const retained = await f.read();
  expect(retained.containers).toEqual([container(replacement)]);
  expect(retained.calls).toEqual([]);
});
test("exact removal and already-absent replay only affect the original full ID", async () => {
  const f = await fixture();
  expect((await f.run(DOCKER_RUNTIME_STOP_PROGRAM)).code).toBe(0);
  expect((await f.run(DOCKER_RUNTIME_STOP_PROGRAM)).code).toBe(0);
  expect(await f.read()).toMatchObject({
    containers: [],
    calls: [
      ["stop", original],
      ["rm", original],
    ],
  });
});
test("unavailable Docker transport does not become confirmed absence", async () => {
  const f = await fixture();
  await f.write({ containers: [], calls: [], unavailable: true });
  const result = await f.run(DOCKER_RUNTIME_OBSERVATION_PROGRAM);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("docker_observation_unavailable");
  expect(result.stdout).toBe("");
});
test("a changed host boot or foreign ownership refuses exact removal", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "boot"), "20000000-0000-4000-8000-000000000002");
  expect((await f.run(DOCKER_RUNTIME_STOP_PROGRAM)).stderr).toContain("node_incarnation_changed");
  expect((await f.read()).calls).toEqual([]);
  await writeFile(join(f.root, "boot"), boot);
  const foreign = container(original);
  foreign.Config.Labels["ai.elizaos.org-id"] = "20000000-0000-4000-8000-000000000003";
  await f.write({ containers: [foreign], calls: [], unavailable: false });
  expect((await f.run(DOCKER_RUNTIME_STOP_PROGRAM)).stderr).toContain(
    "container_ownership_changed",
  );
  expect((await f.read()).calls).toEqual([]);
});
