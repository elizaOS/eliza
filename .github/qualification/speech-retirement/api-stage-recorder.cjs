/** Explicit experiment-only resource actuator plus stage metadata. Sampler remains read-only. */
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const contextPath = '/run/native-resource-experiment.json';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
function readBounded(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    check(info.isFile() && info.size > 0 && info.size <= maximum, 'Resource context input bounds');
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      check(total <= maximum, 'Resource input grew beyond bounds');
      chunks.push(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    check(total === info.size && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ino === info.ino && after.dev === info.dev, 'Resource input changed');
    return Buffer.concat(chunks, total);
  } finally { fs.closeSync(fd); }
}
function context() {
  // This source fork is experiment-only: absence never downgrades to an unbudgeted run.
  const raw = readBounded(contextPath, 8192), value = JSON.parse(raw);
  check(value.schema === 'NATIVE_API_ONLY_RESOURCE_EXPERIMENT_V1', 'Resource context schema');
  const r = value.root, claim = value.claim, container = value.container, target = value.target;
  check(r.measurementOnly === true && r.allowNativeCompilerMeasurement === true && r.allowNativeSoftMemoryBudgetActuation === true, 'Resource opt-in required');
  check(r.nativeBudgetStage === 'api-normal-tsc' && r.nativeResourceKey === 'GOMEMLIMIT' && r.nativeGoSoftMemoryLimitBytes === 6442450944 && r.nativeGoSoftMemoryLimitEnv === '6GiB', 'Resource key/value/stage not approved');
  check(/^[a-f0-9]{64}$/.test(r.rootGOSHA256) && /^[a-f0-9]{32}$/.test(r.intentId), 'Resource authorization identity');
  check(claim.rootGOsha256 === r.rootGOSHA256 && claim.intentId === r.intentId && claim.actualRunId === container.runId && claim.attempt === 1, 'Resource claim mismatch');
  for (const key of ['measurementOnly', 'allowNativeCompilerMeasurement', 'allowNativeSoftMemoryBudgetActuation', 'nativeBudgetStage', 'nativeResourceKey', 'nativeGoSoftMemoryLimitBytes', 'nativeGoSoftMemoryLimitEnv']) {
    check(claim[key] === r[key], 'Resource claim opt-in/value mismatch');
  }
  check(value.source.commit === 'b93db8d7822bce098d65ee88560e6663ea259b8a' && value.source.tree === 'cd96bb6da937deb3419930432c1d2b35374d74a8' && /^[a-f0-9]{64}$/.test(value.source.sealSHA256) && /^[a-f0-9]{64}$/.test(value.source.policySHA256), 'Resource source binding');
  check(Date.now() / 1000 < r.expiresEpoch && r.expiresEpoch <= r.issuedEpoch + 1200, 'Resource authorization expired');
  check(/^[a-f0-9]{64}$/.test(container.cid) && container.hostname === container.cid.slice(0, 12) && os.hostname() === container.hostname, 'Resource container hostname identity');
  check(container.name === 'normal-api-' + container.runId + '-1-normal-api-entry' && container.labels.run === container.runId && container.labels.kind === 'speech-retirement', 'Resource container/label binding');
  const resources = container.resources;
  check(resources.memoryBytes === 8589934592 && resources.memorySwapBytes === 8589934592 && resources.nanoCpus === 2000000000 && resources.pidsLimit === 256 && resources.cgroupParent === 'system.slice', 'Resource hard-cap binding');
  check(target.cwd === '/workspace/packages/cloud/api' && target.stage === 'api-normal-tsc' && JSON.stringify(target.argv) === '["--noEmit"]', 'Resource canonical target');
  check(target.wrapperSHA256 === '2219f428a7e55aaf1f7ad85b9b0f0cf5078aeb76ccc9a7c6036c92d48f492ffd' && target.native.sha256 === '4f2de678286401759b3fb4475bafe35b8f32b4b3a07d92642bbf37eadc9b34a4', 'Resource compiler identity');
  check(target.native.librarySHA256 === 'cbdfbf11c26ed00dfc073155e316a42d6d6d8a387be61006b82fa9aa93ac572e' && target.native.resolverSHA256 === '96c10fd3a18e165d7323de8e314ac8d755ad96811f9fbc304a5b3ba4e05285cc', 'Resource consumer source identity');
  check(target.native.goBuildInfo?.memoryControl === 'GOMEMLIMIT_SUPPORTED_SOFT_TARGET' && /^go1\.(26|27)\.\d+$/.test(target.native.goBuildInfo.version), 'Resource native runtime support');
  check(hash(readBounded(__filename, 65536)) === value.preloadSHA256, 'Resource preload identity');
  check(process.env.NODE_OPTIONS === '--max-old-space-size=4096 --require=/results/api-stage-recorder.cjs', 'Unexpected preload/resource options');
  return { value, contextSHA256: hash(raw) };
}
function identity(stage, cwd, executable) {
  const procStat = fs.readFileSync('/proc/self/stat', 'utf8');
  const birth = procStat.slice(procStat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  check(/^\d+$/.test(birth), 'Unknown process birth');
  return { stage, pid: process.pid, parentPid: process.ppid, procBirthTicks: birth,
    cwd, executable, executableSHA256: hash(readBounded(executable, 1048576)),
    argv: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS,
    exitHookScope: 'Node process only; successful execve replaces this hook' };
}
function appendStage(row) {
  const target = '/results/API-STAGES.jsonl', data = JSON.stringify({ ...row, at: Date.now() }) + '\n';
  check(Buffer.byteLength(data) <= 8192, 'Stage event bounds');
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
  try {
    check(fs.fstatSync(fd).size + Buffer.byteLength(data) <= 1048576, 'Stage stream bounds');
    fs.writeFileSync(fd, data);
  } finally { fs.closeSync(fd); }
}
function actuate(approved, observed) {
  const { value, contextSHA256 } = approved;
  check(observed.cwd === value.target.cwd && observed.executable === value.target.wrapperFile && observed.executableSHA256 === value.target.wrapperSHA256 && JSON.stringify(observed.argv) === '["--noEmit"]', 'Actuator target mismatch');
  check(!Object.hasOwn(process.env, 'GOMEMLIMIT'), 'Unexpected pre-existing native resource policy');
  check(hash(readBounded(value.target.native.library, 8192)) === value.target.native.librarySHA256 &&
        hash(readBounded(value.target.native.resolver, 16384)) === value.target.native.resolverSHA256 &&
        hash(readBounded(value.target.native.file, 67108864)) === value.target.native.sha256, 'Resource consumer changed before actuation');
  const target = '/results/NATIVE-RESOURCE-APPLIED.json';
  let fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const closeOwned = () => { if (fd !== null) { const owned = fd; fd = null; fs.closeSync(owned); } };
  let applied = false;
  try {
    check(fs.fstatSync(fd).size === 0, 'Resource witness was not fresh');
    process.env.GOMEMLIMIT = value.root.nativeGoSoftMemoryLimitEnv;
    applied = true;
    check(process.env.GOMEMLIMIT === '6GiB', 'Resource assignment failed');
    const row = { state: 'RESOURCE_EXPERIMENT_ONLY_SINGLE_KEY_APPLIED', key: 'GOMEMLIMIT', value: '6GiB', bytes: 6442450944,
      oldState: 'UNSET', stage: observed.stage, pid: observed.pid, procBirthTicks: observed.procBirthTicks,
      cwd: observed.cwd, wrapperSHA256: observed.executableSHA256, nativeSHA256: value.target.native.sha256,
      nativeGoVersion: value.target.native.goBuildInfo.version, contextSHA256, rootGOSHA256: value.root.rootGOSHA256,
      intentId: value.root.intentId, cid: value.container.cid, evidence: 'SOURCE_BOUND_INITIAL_ENV_INHERITANCE_NOT_NATIVE_ENV_OR_INTERNAL_RUNTIME_MEASUREMENT',
      typeAcceptance: 'NOT_ISSUED', at: Date.now() };
    const data = JSON.stringify(row) + '\n';
    check(Buffer.byteLength(data) <= 4096, 'Resource witness bounds');
    fs.writeFileSync(fd, data);
    closeOwned();
  } catch (error) {
    if (applied) delete process.env.GOMEMLIMIT;
    try { closeOwned(); } catch {}
    throw error;
  }
}

let ownedEffectApplied = false;
try {
  const approved = context(), target = approved.value.target;
  const cwd = fs.realpathSync(process.cwd());
  const executable = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
  let stage;
  if (cwd === target.cwd) {
    if (executable === target.wrapperFile) {
      // Informational invocations must not receive a memory experiment.
      if (process.argv.slice(2).some(arg => ['--version', '-v', '--help', '-h'].includes(arg))) return;
      check(JSON.stringify(process.argv.slice(2)) === '["--noEmit"]', 'Unexpected API compiler arguments');
      stage = 'api-normal-tsc';
    } else if (executable === '/workspace/packages/cloud/api/test/_router-contract.mjs') stage = 'api-router-contract';
    else if (executable === approved.value.wrangler.file) {
      check(process.argv.includes('--dry-run') && process.argv.includes('production') && process.argv.includes('deploy'), 'Only canonical worker dry-run is allowed');
      stage = 'api-worker-dry-run';
    }
  }
  if (stage) {
    const observed = identity(stage, cwd, executable);
    if (stage === 'api-normal-tsc') { actuate(approved, observed); ownedEffectApplied = true; }
    appendStage({ ...observed, event: 'start' });
    process.once('exit', code => {
      try { appendStage({ ...observed, event: 'exit', code }); }
      catch { process.stderr.write('[resource experiment stage receipt failed]\n'); }
    });
  }
} catch (error) {
  // This experiment fork never swallows a guard or pre-launch witness failure.
  if (ownedEffectApplied && process.env.GOMEMLIMIT === '6GiB') delete process.env.GOMEMLIMIT;
  process.stderr.write('[resource experiment guard failed before compiler launch]\n');
  throw error;
}
