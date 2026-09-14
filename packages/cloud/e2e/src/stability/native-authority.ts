/**
 * Binds a root-installed native observer to the reviewed checkout before a run.
 * The privileged query returns public hashes only; private signing material is
 * generated later through the independent per-attempt control channel.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";
import { canonicalJsonString } from "@elizaos/shared/canonical-json";
import { assertSandboxReadableSource } from "./linux-sandbox.ts";
import type { NativeExpectedContext } from "./native-attestation-channel.ts";

export const NATIVE_AUTHORITY_VALIDATOR = String.raw`import os,sys,stat,json,hashlib

fds=[]
def pin(name,maximum):
    if not name.startswith('/') or os.path.normpath(name)!=name:
        raise RuntimeError('native authority path is not canonical')
    parts=name.split('/')[1:]
    if not parts or len(parts)>64:
        raise RuntimeError('native authority path depth is unsupported')
    parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    fds.append(parent)
    for part in parts[:-1]:
        parent=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        fds.append(parent)
        info=os.fstat(parent)
        if info.st_uid!=0 or info.st_mode&0o022:
            raise RuntimeError('native authority directory is not immutable root ownership')
    fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    fds.append(fd)
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022 or info.st_size>maximum:
        raise RuntimeError('native authority file is not immutable root ownership')
    chunks=[];size=0
    while True:
        value=os.read(fd,min(65536,maximum+1-size))
        if not value:break
        chunks.append(value);size+=len(value)
        if size>maximum:raise RuntimeError('native authority file exceeds boundary')
    after=os.fstat(fd)
    if (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):
        raise RuntimeError('native authority changed during pinned read')
    return b''.join(chunks)

try:
    owner=sys.argv[1];expected=json.loads(sys.argv[2]);arguments=sys.argv[3:]
    root=os.path.dirname(owner)
    names={'stability-sandbox-identity.py','stability-sandbox-exec.py','stability-sandbox-owner.py','stability-native-attestation.py','stability-linux-sandbox.sh','native-ledger/ledger.h','native-ledger/ledger.bpf.c','native-ledger/retirement.h','native-ledger/retirement.bpf.c','native-ledger/collector.c'}
    if set(expected)!=names or owner!=root+'/stability-sandbox-owner.py':
        raise RuntimeError('native authority inventory differs from protocol')
    sources={}
    for name in sorted(names):
        value=pin(root+'/'+name,4*1024*1024)
        if hashlib.sha256(value).hexdigest()!=expected[name]:
            raise RuntimeError('native authority source differs from checkout')
        sources[name]=value
    manifest=json.loads(pin(root+'/native-ledger/build.json',65536))
    for name in ['ledger.h','ledger.bpf.c','retirement.h','retirement.bpf.c','collector.c']:
        if manifest['sources'][name]!=expected['native-ledger/'+name]:
            raise RuntimeError('native build source inventory differs')
    for name in ['collector','ledger.bpf.o','retirement.bpf.o']:
        value=pin(root+'/native-ledger/'+name,64*1024*1024)
        if hashlib.sha256(value).hexdigest()!=manifest['artifacts'][name]:
            raise RuntimeError('native build artifact differs')
    sys.argv=[owner]+arguments
    exec(compile(sources['stability-sandbox-owner.py'],owner,'exec'),{'__name__':'__main__','__file__':owner})
finally:
    for fd in reversed(fds):os.close(fd)
`;

function command(executable: string, args: string[], cwd: string): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    killSignal: "SIGKILL",
    maxBuffer: 65536,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  if (result.error || result.status !== 0 || result.signal)
    throw new ElizaError(
      "Native authority preflight failed before run admission",
      {
        code: "STABILITY_NATIVE_AUTHORITY_UNAVAILABLE",
        cause: result.error,
        context: {
          executable,
          status: result.status,
          signal: result.signal,
          diagnostic: result.stderr,
        },
      },
    );
  return result.stdout.trim();
}
const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: Record<string, string>): string {
  return canonicalJsonString(value, {
    maxDepth: 4,
    maxNodes: 128,
    maxOutputChars: 16384,
    sparseArrayHoles: "null",
    onUnbounded: () => {
      throw new Error("Native source inventory exceeds its protocol boundary");
    },
  });
}
export function readNativeAuthority(
  repoRoot: string,
  installedRoot: string,
): {
  ownerScript: string;
  nativeBundle: string;
  context: NativeExpectedContext;
} {
  assertSandboxReadableSource(repoRoot);
  if (
    !path.isAbsolute(installedRoot) ||
    path.resolve(installedRoot) !== installedRoot ||
    installedRoot.includes("\0")
  )
    throw new ElizaError(
      "--native-root must identify the canonical root-installed observer directory",
      { code: "STABILITY_NATIVE_AUTHORITY_INVALID" },
    );
  const ownerScript = path.join(installedRoot, "stability-sandbox-owner.py");
  const nativeBundle = path.join(installedRoot, "native-ledger");
  const scripts = path.join(repoRoot, "packages/cloud/e2e/scripts");
  const expectedSources: Record<string, string> = {};
  for (const name of [
    "stability-sandbox-identity.py",
    "stability-sandbox-exec.py",
    "stability-sandbox-owner.py",
    "stability-native-attestation.py",
    "stability-linux-sandbox.sh",
    "native-ledger/ledger.h",
    "native-ledger/ledger.bpf.c",
    "native-ledger/retirement.h",
    "native-ledger/retirement.bpf.c",
    "native-ledger/collector.c",
  ])
    expectedSources[name] = digest(readFileSync(path.join(scripts, name)));
  const parsed: unknown = JSON.parse(
    command(
      "sudo",
      [
        "-n",
        "/usr/bin/python3",
        "-I",
        "-S",
        "-c",
        NATIVE_AUTHORITY_VALIDATOR,
        ownerScript,
        JSON.stringify(expectedSources),
        "native-context",
        path.join(installedRoot, "stability-linux-sandbox.sh"),
        nativeBundle,
      ],
      repoRoot,
    ),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Native authority returned an invalid context");
  const record = parsed as Record<string, unknown>;
  const fields = [
    "buildSha256",
    "btfSha256",
    "kernelRelease",
    "policySha256",
    "guardianSha256",
    "signerSha256",
    "launcherSha256",
    "nativeSourcesSha256",
  ];
  if (Object.keys(record).sort().join("\0") !== fields.sort().join("\0"))
    throw new Error("Native authority context fields changed");
  const context: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    if (
      typeof value !== "string" ||
      (name === "kernelRelease"
        ? !/^[A-Za-z0-9._+-]+$/.test(value)
        : !/^[a-f0-9]{64}$/.test(value))
    )
      throw new Error("Native authority returned an invalid source identity");
    context[name] = value;
  }
  for (const [field, name] of Object.entries({
    guardianSha256: "stability-sandbox-owner.py",
    signerSha256: "stability-native-attestation.py",
    launcherSha256: "stability-linux-sandbox.sh",
  })) {
    if (digest(readFileSync(path.join(scripts, name))) !== context[field])
      throw new Error(
        "Installed native authority differs from the current checkout",
      );
  }
  const nativeSources: Record<string, string> = {};
  for (const name of [
    "ledger.h",
    "ledger.bpf.c",
    "retirement.h",
    "retirement.bpf.c",
    "collector.c",
  ])
    nativeSources[name] = digest(
      readFileSync(path.join(scripts, "native-ledger", name)),
    );
  if (digest(canonical(nativeSources)) !== context.nativeSourcesSha256)
    throw new Error(
      "Installed native producer differs from the current checkout",
    );
  for (const [name, ref] of Object.entries({
    head: "HEAD",
    base: "origin/develop",
    tree: "HEAD^{tree}",
  })) {
    const value = command("git", ["rev-parse", "--verify", ref], repoRoot);
    if (!/^[a-f0-9]{40}$/.test(value))
      throw new Error("Native run source reference is invalid");
    context[name] = value;
  }
  context.sourceState =
    command("git", ["status", "--porcelain"], repoRoot) === ""
      ? "clean"
      : "private-working-source";
  const integrations: Record<string, string> = {};
  for (const name of [
    "packages/cloud/e2e/scripts/stability-attempt.ts",
    "packages/cloud/e2e/src/stability/native-admission.ts",
    "packages/cloud/e2e/src/stability/native-bootstrap.ts",
    "packages/cloud/e2e/src/stability/native-authority.ts",
    "packages/cloud/e2e/src/stability/native-attestation-channel.ts",
    "packages/cloud/e2e/src/stability/native-ledger-evidence.ts",
    "packages/cloud/e2e/src/stability/cloud-stability-runner.ts",
    "packages/scenario-runner/src/stability-subprocess-adapter.ts",
  ])
    integrations[name] = digest(readFileSync(path.join(repoRoot, name)));
  context.integrationSourcesSha256 = digest(canonical(integrations));
  context.privilegedSourcesSha256 = digest(canonical(expectedSources));
  return { ownerScript, nativeBundle, context: Object.freeze(context) };
}
