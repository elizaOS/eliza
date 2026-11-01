/**
 * Fail-closed Cloudflare readback of the production admission namespace.
 *
 * Releases check the live state before and after each upload (`--stage`).
 * Root checks each transfer phase (`--phase`): the expected owner, every
 * binding of the namespace in the account, the class exports, the effective
 * variables, the saved object sample and continuity with the previous receipt.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// The existing production namespace. A transfer moves its owner, never its ID.
export const PRODUCTION_ADMISSION_NAMESPACE_ID =
  "9e1a8820e95d4dcaa5867c0e37ea581b";
const GATE = "InferenceAdmissionGate";
const GATE_BINDING = "INFERENCE_ADMISSION_GATES";
const DEPLOY_COMMIT = "ELIZA_DEPLOY_COMMIT";

// Scripts outside this repository that bind the namespace by the API's class.
// Root's phase readback proves each binding record is unchanged: this
// namespace ID, the class and the API as `script_name`, on a version that
// never changes during the transfer. Cloudflare does not show how that record
// resolves at runtime in each phase; only a rehearsal can. A release does not
// depend on these diagnostic Workers: it accepts a deleted one, and a present
// one must keep its record. Rebinding one is a reviewed change to this list;
// anything else stops the readback.
export const KNOWN_EXTERNAL_CONSUMERS = [
  { script: "diag-admission-caller-9bd05690", binding: "PRODUCTION" },
] as const;

// Variables the gate reads that the target does not carry. Unless Root's
// receipts set them, the live API leaves them unset, and the target matches
// the API. The Maps allowance controller reads the last two from the gate's
// environment.
export const UNCARRIED_GATE_VARIABLES = [
  "INFERENCE_FUNDED_BUDGET_ADMISSION",
  "INFERENCE_RATE_POLICY_ADMISSION",
  "ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES",
  "ELIZA_CLOUD_PLAN_RATE_LIMITS",
] as const;

// The live state after each step, in execution order. `owner` owns the
// namespace; `apiGate` is the script the API's binding names; the target's
// own binding is `bound`, `unbound` (none) or the target is `absent`.
// `deploys` is the one Worker the step uploads.
export const LIVE_PHASES = {
  "source-owned": {
    owner: "api",
    apiGate: "api",
    target: "absent",
    deploys: undefined,
  },
  "target-pending": {
    owner: "api",
    apiGate: "api",
    target: "unbound",
    deploys: "target",
  },
  "source-commit": {
    owner: "target",
    apiGate: "target",
    target: "unbound",
    deploys: "api",
  },
  adopted: {
    owner: "target",
    apiGate: "target",
    target: "bound",
    deploys: "target",
  },
  "reverse-pending": {
    owner: "target",
    apiGate: "target",
    target: "bound",
    deploys: "api",
  },
  "reverse-commit": {
    owner: "api",
    apiGate: "target",
    target: "unbound",
    deploys: "target",
  },
  "reverse-adopted": {
    owner: "api",
    apiGate: "api",
    target: "unbound",
    deploys: "api",
  },
} as const;
export type LivePhase = keyof typeof LIVE_PHASES;
type Side = "api" | "target";

// The committed phases a production release may publish, each with the live
// phases it may start from. `adopted` and `reverse-adopted` are steady states;
// `reverse-pending` and `reverse-adopted` also take one API step of the
// reverse transfer from their predecessor. Every other phase is Root's CLI.
export const RELEASE_PHASES = {
  adopted: ["adopted"],
  "reverse-pending": ["adopted", "reverse-pending"],
  "reverse-adopted": ["reverse-commit", "reverse-adopted"],
} as const satisfies Partial<Record<LivePhase, readonly LivePhase[]>>;
export type ReleasePhase = keyof typeof RELEASE_PHASES;

export type CloudflareRead = (path: string) => Promise<{
  result?: unknown;
  result_info?: Record<string, unknown>;
}>;
type Binding = Record<string, unknown>;
interface Namespace {
  id: string;
  class?: string;
  script?: string;
  use_sqlite?: boolean;
}
type Digests = Record<string, string>;
export interface Receipt {
  phase: LivePhase;
  namespace: string;
  owner: string;
  api: { script: string; version: string; commit?: unknown };
  target: { script: string; version: string; commit?: unknown } | null;
  consumers: { script: string; binding: string; version: string }[];
  namespaceBindings?: string[];
  parityVariables?: string[];
  apiVariables?: Digests;
  targetVariables?: Digests;
  objectSample?: Record<string, unknown>;
}
export interface EffectiveVariables {
  variables: Map<string, string>;
  version?: string;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const NAMESPACE_PAGE_SIZE = 100;
const NAMESPACE_PAGE_LIMIT = 50;

/**
 * Every namespace, or an error. Each page must carry counts that add up, and
 * the listing ends only on a short page, so a total that is a multiple of the
 * page size still reads the empty page after it.
 */
export async function listNamespaces(read: CloudflareRead) {
  const namespaces = new Map<string, Namespace>();
  let total: unknown;
  for (let page = 1; page <= NAMESPACE_PAGE_LIMIT; page += 1) {
    const { result, result_info: info } = await read(
      `/workers/durable_objects/namespaces?per_page=${NAMESPACE_PAGE_SIZE}&page=${page}`,
    );
    total ??= info?.total_count;
    if (
      !Array.isArray(result) ||
      !info ||
      typeof total !== "number" ||
      !Number.isSafeInteger(total) ||
      info.total_count !== total ||
      info.page !== page ||
      info.per_page !== NAMESPACE_PAGE_SIZE ||
      info.count !== result.length
    )
      throw new Error(
        `Cloudflare namespace page ${page} has missing or inconsistent pagination`,
      );
    for (const namespace of result as Namespace[]) {
      if (typeof namespace?.id !== "string" || namespaces.has(namespace.id))
        throw new Error(
          `Cloudflare namespace page ${page} repeats or omits a namespace ID`,
        );
      namespaces.set(namespace.id, namespace);
    }
    if (
      namespaces.size > total ||
      (result.length < NAMESPACE_PAGE_SIZE && namespaces.size !== total)
    )
      throw new Error(
        "Cloudflare namespace pages do not add up to their total",
      );
    if (result.length < NAMESPACE_PAGE_SIZE) return [...namespaces.values()];
  }
  throw new Error(
    `Cloudflare namespace listing did not finish within ${NAMESPACE_PAGE_LIMIT} pages`,
  );
}

/**
 * Every script ID, or an error. The account list is one page; any sign of
 * another page, a count that disagrees or a repeated ID fails closed.
 */
export async function listScripts(read: CloudflareRead) {
  const { result, result_info: info } = await read("/workers/scripts");
  if (
    !Array.isArray(result) ||
    result.some((script) => typeof script?.id !== "string")
  )
    throw new Error("Cloudflare did not return the script list");
  const ids: string[] = result.map((script) => script.id);
  if (
    new Set(ids).size !== ids.length ||
    (info &&
      ((info.total_count !== undefined && info.total_count !== ids.length) ||
        (info.count !== undefined && info.count !== ids.length) ||
        (info.page !== undefined && info.page !== 1) ||
        (info.total_pages !== undefined && info.total_pages !== 1) ||
        (typeof info.cursor === "string" && info.cursor !== "")))
  )
    throw new Error("Cloudflare script list is incomplete or paginated");
  return ids;
}

/** The versions of the script's latest deployment; none if never deployed. */
async function servingVersions(read: CloudflareRead, script: string) {
  const deployments = (
    (await read(`/workers/scripts/${script}/deployments`)).result as {
      deployments?: {
        created_on: string;
        versions?: { version_id: string; percentage: number }[];
      }[];
    }
  )?.deployments;
  const [active] = (deployments ?? []).toSorted(
    (left, right) => Date.parse(right.created_on) - Date.parse(left.created_on),
  );
  return active?.versions ?? [];
}

async function activeVersion(read: CloudflareRead, script: string) {
  const versions = await servingVersions(read, script);
  if (!versions.length)
    throw new Error(`${script} has no Cloudflare deployment`);
  if (versions.length !== 1 || versions[0].percentage !== 100)
    throw new Error(`${script} must serve exactly one version at 100%`);
  return readVersion(read, script, versions[0].version_id);
}

async function readVersion(read: CloudflareRead, script: string, id: string) {
  const version = (await read(`/workers/scripts/${script}/versions/${id}`))
    .result as {
    id?: string;
    resources?: {
      bindings?: Binding[];
      script?: { named_handlers?: { name?: string; handlers?: string[] }[] };
    };
  };
  const bindings = version?.resources?.bindings;
  if (version?.id !== id || !Array.isArray(bindings))
    throw new Error(`${script} version ${id} did not read back its bindings`);
  return { id, bindings, handlers: version.resources?.script?.named_handlers };
}

/** The class code stays exported: live, pending or as the tombstone. */
function requireGateClass(
  version: Awaited<ReturnType<typeof activeVersion>>,
  script: string,
) {
  if (
    !Array.isArray(version.handlers) ||
    !version.handlers.some(
      (handler) =>
        handler?.name === GATE &&
        Array.isArray(handler.handlers) &&
        handler.handlers.includes("class"),
    )
  )
    throw new Error(`${script} version ${version.id} does not export ${GATE}`);
}

function named(bindings: Binding[], name: string) {
  const matches = bindings.filter((binding) => binding.name === name);
  if (matches.length > 1) throw new Error(`Duplicate binding ${name}`);
  return matches[0];
}

function plainText(bindings: Binding[], name: string) {
  const binding = named(bindings, name);
  if (binding && binding.type !== "plain_text")
    throw new Error(`${name} is not a plain-text variable`);
  return binding?.text;
}

/** The namespace ID is the identity; `servedBy` is the script it names. */
function requireNamespaceBinding(
  binding: Binding | undefined,
  holder: string,
  servedBy: string,
) {
  if (
    binding?.type !== "durable_object_namespace" ||
    binding.class_name !== GATE ||
    binding.namespace_id !== PRODUCTION_ADMISSION_NAMESPACE_ID ||
    (binding.script_name ?? holder) !== servedBy
  )
    throw new Error(
      `${holder} ${String(binding?.name ?? "binding")} must name ${PRODUCTION_ADMISSION_NAMESPACE_ID} through ${servedBy}`,
    );
}

function requireCommit(bindings: Binding[], script: string, commit: string) {
  if (plainText(bindings, DEPLOY_COMMIT) !== commit)
    throw new Error(`${script} does not serve commit ${commit}`);
}

/**
 * Bindings anywhere in the account that reach the namespace: in each script's
 * latest uploaded version (its settings) and in every version its latest
 * deployment serves, so a gradual rollout cannot hide one. An older uploaded
 * version that no deployment serves is not read.
 */
async function namespaceBindings(
  read: CloudflareRead,
  scripts: string[],
  owners: string[],
) {
  const found = new Set<string>();
  for (const script of scripts) {
    const settings = (
      (await read(`/workers/scripts/${script}/settings`)).result as {
        bindings?: Binding[];
      }
    )?.bindings;
    if (!Array.isArray(settings))
      throw new Error(`${script} settings did not read back its bindings`);
    const bindings = [settings];
    for (const { version_id } of await servingVersions(read, script))
      bindings.push((await readVersion(read, script, version_id)).bindings);
    for (const binding of bindings.flat())
      if (
        binding.type === "durable_object_namespace" &&
        (binding.namespace_id === PRODUCTION_ADMISSION_NAMESPACE_ID ||
          (binding.class_name === GATE &&
            owners.includes(String(binding.script_name ?? script))))
      )
        found.add(`${script}/${String(binding.name)}`);
  }
  return [...found].sort();
}

/**
 * The target's variables are copies of the API's. Compare every one it
 * carries, plus the variables the gate reads that it does not carry.
 */
function requireVariableParity(api: Binding[], target: Binding[]) {
  const names = new Set<string>(UNCARRIED_GATE_VARIABLES);
  for (const binding of target)
    if (binding.type === "plain_text") names.add(String(binding.name));
  names.delete(DEPLOY_COMMIT);
  for (const name of names)
    if (plainText(api, name) !== plainText(target, name))
      throw new Error(`Live variable differs between API and target: ${name}`);
  return [...names].sort();
}

/** Each plain-text variable's SHA-256, so receipts chain values, not text. */
function variableDigests(bindings: Binding[]): Digests {
  return Object.fromEntries(
    bindings
      .filter(
        (binding) =>
          binding.type === "plain_text" && binding.name !== DEPLOY_COMMIT,
      )
      .map((binding) => [String(binding.name), sha256(String(binding.text))])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * Root's effective-variable receipts for one script, merged. They must agree
 * on every value and on the version they read.
 */
export function effectiveVariables(
  receipts: string[],
  script = "eliza-cloud-api-prod",
): EffectiveVariables {
  const variables = new Map<string, string>();
  const versions = new Set<string>();
  for (const text of receipts) {
    const json = JSON.parse(text);
    const table = json?.effectiveFlags?.[script] ?? json?.flags?.[script];
    let entries: [string, unknown][];
    if (Array.isArray(json?.flags))
      entries = json.flags.map((flag: Binding) => {
        if (flag?.type !== "plain_text")
          throw new Error(`Effective variable ${flag?.name} is not plain text`);
        return [flag.name, flag.text];
      });
    else if (table && typeof table === "object")
      entries = Object.entries(table);
    else
      throw new Error(`Unrecognized effective-variable receipt for ${script}`);
    if (json.version !== undefined) versions.add(String(json.version));
    for (const [name, value] of entries) {
      if (
        typeof value !== "string" ||
        (variables.has(name) && variables.get(name) !== value)
      )
        throw new Error(`Effective variable receipts disagree on ${name}`);
      variables.set(name, value);
    }
  }
  if (versions.size > 1)
    throw new Error("Effective variable receipts read different versions");
  return { variables, version: [...versions][0] };
}

/**
 * The live API keeps every value in Root's receipts and leaves the uncarried
 * gate variables unset unless they set them. Until the API deploys again,
 * the receipts must have read the live API version.
 */
function requireEffectiveVariables(
  api: Binding[],
  apiVersion: string,
  phase: LivePhase,
  effective: EffectiveVariables,
) {
  if (
    ["source-owned", "target-pending"].includes(phase) &&
    effective.version !== apiVersion
  )
    throw new Error(
      `Effective variable receipts read ${String(effective.version)}, not the live API version ${apiVersion}`,
    );
  for (const [name, value] of effective.variables)
    if (name !== DEPLOY_COMMIT && plainText(api, name) !== value)
      throw new Error(`Live API ${name} differs from Root's receipts`);
  for (const name of UNCARRIED_GATE_VARIABLES)
    if (!effective.variables.has(name) && named(api, name))
      throw new Error(
        `Live API sets ${name}, which Root's receipts leave unset`,
      );
}

/**
 * Proves one live state. `commits` names the commit each listed Worker must
 * serve. `effective` (Root's phase proof) also scans every script's bindings
 * for the namespace and checks variables against Root's receipts.
 */
export async function verifyProductionAdmission(
  read: CloudflareRead,
  options: {
    api: string;
    target: string;
    phase: LivePhase;
    commits?: Partial<Record<Side, string>>;
    effective?: EffectiveVariables;
  },
): Promise<Receipt> {
  const expected = LIVE_PHASES[options.phase];
  const scriptOf = (side: Side) => options[side];
  const namespaces = await listNamespaces(read);
  const existing = namespaces.filter(
    (namespace) => namespace.id === PRODUCTION_ADMISSION_NAMESPACE_ID,
  );
  if (
    existing.length !== 1 ||
    existing[0].class !== GATE ||
    existing[0].use_sqlite !== true
  )
    throw new Error("The existing SQLite admission namespace is not present");
  if (existing[0].script !== scriptOf(expected.owner))
    throw new Error(
      `${options.phase} requires ${scriptOf(expected.owner)} to own the namespace, found ${String(existing[0].script)}`,
    );
  if (
    namespaces.some(
      (namespace) =>
        namespace.id !== PRODUCTION_ADMISSION_NAMESPACE_ID &&
        namespace.class === GATE &&
        [options.api, options.target].includes(String(namespace.script)),
    )
  )
    throw new Error("A second production admission namespace exists");

  const scriptIds = await listScripts(read);
  if (scriptIds.includes(options.target) !== (expected.target !== "absent"))
    throw new Error(
      `${options.phase} requires ${options.target} to ${expected.target === "absent" ? "not exist" : "exist"}`,
    );
  // Root's phase proof requires every known consumer; a release reads only
  // the ones that still exist.
  const knownConsumers = KNOWN_EXTERNAL_CONSUMERS.filter(
    (consumer) => options.effective || scriptIds.includes(consumer.script),
  );
  for (const script of [
    options.api,
    ...knownConsumers.map((consumer) => consumer.script),
  ])
    if (!scriptIds.includes(script))
      throw new Error(`The script list does not include ${script}`);

  const api = await activeVersion(read, options.api);
  requireGateClass(api, options.api);
  requireNamespaceBinding(
    named(api.bindings, GATE_BINDING),
    options.api,
    scriptOf(expected.apiGate),
  );
  const target =
    expected.target === "absent"
      ? undefined
      : await activeVersion(read, options.target);
  if (target) {
    requireGateClass(target, options.target);
    const gate = named(target.bindings, GATE_BINDING);
    if (expected.target === "bound")
      requireNamespaceBinding(gate, options.target, options.target);
    else if (gate)
      throw new Error(
        `${options.phase} forbids a binding on ${options.target}`,
      );
    const recovery = named(target.bindings, "INFERENCE_RECOVERY_SERVICE");
    if (
      recovery?.type !== "service" ||
      recovery.service !== options.api ||
      recovery.entrypoint !== "InferenceRecoveryService"
    )
      throw new Error(
        `${options.target} must recover through ${options.api} InferenceRecoveryService`,
      );
  }
  for (const [side, commit] of Object.entries(options.commits ?? {})) {
    const worker = side === "api" ? api : target;
    if (!worker || !commit)
      throw new Error(`${options.phase} has no ${side} commit to check`);
    requireCommit(worker.bindings, scriptOf(side as Side), commit);
  }

  const consumers = [];
  for (const consumer of knownConsumers) {
    const version = await activeVersion(read, consumer.script);
    requireNamespaceBinding(
      named(version.bindings, consumer.binding),
      consumer.script,
      options.api,
    );
    consumers.push({ ...consumer, version: version.id });
  }

  const receipt: Receipt = {
    phase: options.phase,
    namespace: PRODUCTION_ADMISSION_NAMESPACE_ID,
    owner: scriptOf(expected.owner),
    api: {
      script: options.api,
      version: api.id,
      commit: plainText(api.bindings, DEPLOY_COMMIT),
    },
    target: target
      ? {
          script: options.target,
          version: target.id,
          commit: plainText(target.bindings, DEPLOY_COMMIT),
        }
      : null,
    consumers,
  };
  if (!options.effective) return receipt;

  const expectedBindings = [
    `${options.api}/${GATE_BINDING}`,
    ...KNOWN_EXTERNAL_CONSUMERS.map(
      (consumer) => `${consumer.script}/${consumer.binding}`,
    ),
    ...(expected.target === "bound"
      ? [`${options.target}/${GATE_BINDING}`]
      : []),
  ].sort();
  receipt.namespaceBindings = await namespaceBindings(read, scriptIds, [
    options.api,
    options.target,
  ]);
  if (
    JSON.stringify(receipt.namespaceBindings) !==
    JSON.stringify(expectedBindings)
  )
    throw new Error(
      `Namespace bindings differ from ${options.phase}: ${receipt.namespaceBindings.join(", ")}`,
    );
  requireEffectiveVariables(
    api.bindings,
    api.id,
    options.phase,
    options.effective,
  );
  receipt.apiVariables = variableDigests(api.bindings);
  if (target) {
    receipt.parityVariables = requireVariableParity(
      api.bindings,
      target.bindings,
    );
    receipt.targetVariables = variableDigests(target.bindings);
  }
  return receipt;
}

/**
 * The live phases a release step may find, and the Worker commits it pins.
 * Before an upload the live state is the committed phase or, for an API step
 * of the reverse transfer, its predecessor. After it, it is the committed
 * phase with this release's commit on every Worker the release uploaded.
 */
export function releaseCheck(
  stage: "before" | "admission" | "api",
  phase: ReleasePhase,
  commit?: string,
): { phases: readonly LivePhase[]; commits: Partial<Record<Side, string>> } {
  if (stage === "before") return { phases: RELEASE_PHASES[phase], commits: {} };
  if (stage === "admission" && phase !== "adopted")
    throw new Error(`A ${phase} release does not upload the admission Worker`);
  return {
    phases: [phase],
    commits:
      stage === "admission"
        ? { target: commit }
        : phase === "adopted"
          ? { target: commit, api: commit }
          : { api: commit },
  };
}

/** The first of `phases` the live state proves, or every reason it is none. */
export async function verifyAnyPhase(
  phases: readonly LivePhase[],
  verify: (phase: LivePhase) => Promise<Receipt>,
) {
  const reasons: string[] = [];
  for (const phase of phases) {
    try {
      return await verify(phase);
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `The live state is not ${phases.join(" or ")}: ${reasons.join("; ")}`,
  );
}

/**
 * Root's saved sample: `[{id, hasStoredData}]` or `{namespace, objects}`.
 * Its counts and identity hash must match the public summary. The identity
 * hash is the SHA-256 of the sorted IDs joined by single newlines.
 */
export function parseObjectSample(text: string, summaryText: string) {
  const json = JSON.parse(text);
  const list = Array.isArray(json) ? json : json?.objects;
  if (
    !Array.isArray(list) ||
    !list.length ||
    (!Array.isArray(json) &&
      json.namespace !== undefined &&
      json.namespace !== PRODUCTION_ADMISSION_NAMESPACE_ID)
  )
    throw new Error(
      "Object sample must list {id, hasStoredData} objects of the namespace",
    );
  const sample = new Map<string, boolean>();
  for (const object of list) {
    if (
      typeof object?.id !== "string" ||
      !/^[0-9a-f]{64}$/.test(object.id) ||
      typeof object.hasStoredData !== "boolean" ||
      sample.has(object.id)
    )
      throw new Error("Object sample has a malformed or repeated entry");
    sample.set(object.id, object.hasStoredData);
  }
  const summary = JSON.parse(summaryText);
  if (
    summary?.namespace !== PRODUCTION_ADMISSION_NAMESPACE_ID ||
    summary.observedObjects !== sample.size ||
    summary.storedDataObjects !== [...sample.values()].filter(Boolean).length
  )
    throw new Error("Object sample does not match its saved summary counts");
  const identitySetSHA256 = sha256([...sample.keys()].sort().join("\n"));
  if (summary.identitySetSHA256 !== identitySetSHA256)
    throw new Error(
      "Object sample IDs do not match the summary's identitySetSHA256 (SHA-256 of the sorted IDs joined by newlines)",
    );
  return { sample, identitySetSHA256 };
}

const OBJECT_PAGE_SIZE = 10_000;
const OBJECT_PAGE_LIMIT = 100;

/**
 * Finds every sampled object by ID in the namespace, wherever enumeration
 * lists it. A missing sampled object that had stored data stops the transfer.
 * One that had none may drop out of enumeration in normal operation, so those
 * are counted, and only losing most of them stops the transfer. The gate
 * deletes keys in normal traffic, so a sampled object may gain or lose stored
 * data; both are counted. Losing it in most of the sample looks like a wipe
 * and stops the transfer.
 */
export async function verifyObjectSample(
  read: CloudflareRead,
  sample: Map<string, boolean>,
) {
  const remaining = new Map(sample);
  const listed = new Set<string>();
  const cursors = new Set<string>();
  let cursor = "";
  let gainedStoredData = 0;
  let lostStoredData = 0;
  for (let page = 1; page <= OBJECT_PAGE_LIMIT; page += 1) {
    const { result, result_info: info } = await read(
      `/workers/durable_objects/namespaces/${PRODUCTION_ADMISSION_NAMESPACE_ID}/objects?limit=${OBJECT_PAGE_SIZE}${cursor && `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    if (!Array.isArray(result) || info?.count !== result.length)
      throw new Error(
        `Cloudflare object page ${page} has missing or inconsistent pagination`,
      );
    for (const object of result) {
      if (
        typeof object?.id !== "string" ||
        typeof object.hasStoredData !== "boolean" ||
        listed.has(object.id)
      )
        throw new Error(
          `Cloudflare object page ${page} repeats or malforms an object`,
        );
      listed.add(object.id);
      const before = remaining.get(object.id);
      if (before === undefined) continue;
      remaining.delete(object.id);
      if (before && !object.hasStoredData) lostStoredData += 1;
      if (!before && object.hasStoredData) gainedStoredData += 1;
    }
    const next = info.cursor;
    if (remaining.size && typeof next === "string" && next) {
      if (cursors.has(next))
        throw new Error("Cloudflare object cursor repeated");
      cursors.add(next);
      cursor = next;
      continue;
    }
    const storedDataBefore = [...sample.values()].filter(Boolean).length;
    const missing = [...remaining.values()];
    const missingStoredData = missing.filter(Boolean).length;
    const missingWithoutStoredData = missing.length - missingStoredData;
    if (missingStoredData)
      throw new Error(
        `${missingStoredData} sampled objects with stored data are missing from the namespace`,
      );
    if (missingWithoutStoredData * 2 > sample.size - storedDataBefore)
      throw new Error(
        `${missingWithoutStoredData} of ${sample.size - storedDataBefore} sampled objects without stored data are missing from the namespace`,
      );
    if (lostStoredData * 2 > storedDataBefore)
      throw new Error(
        `${lostStoredData} of ${storedDataBefore} sampled objects lost their stored data`,
      );
    return {
      sampled: sample.size,
      storedDataBefore,
      gainedStoredData,
      lostStoredData,
      missingWithoutStoredData,
      listed: listed.size,
      pages: page,
    };
  }
  throw new Error(
    `Cloudflare object listing did not reach every sampled object within ${OBJECT_PAGE_LIMIT} pages`,
  );
}

function changedNames(before: Digests = {}, after: Digests = {}) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .sort();
}

/**
 * A phase follows the previous receipt or repeats it. Only the Worker the
 * phase deploys may change version; every known consumer stays on its
 * version; the sample file and every API and target variable stay the same.
 */
export function requirePhaseContinuity(previous: Receipt, current: Receipt) {
  const order = Object.keys(LIVE_PHASES);
  const step = order.indexOf(current.phase) - order.indexOf(previous.phase);
  if (
    previous.namespace !== current.namespace ||
    order.indexOf(previous.phase) < 0 ||
    (step !== 0 && step !== 1)
  )
    throw new Error(`${current.phase} cannot follow ${previous.phase}`);
  const deployed = step === 1 ? LIVE_PHASES[current.phase].deploys : undefined;
  if (deployed !== "api" && previous.api.version !== current.api.version)
    throw new Error("The API version changed outside its phase");
  if (
    deployed !== "target" &&
    previous.target?.version !== current.target?.version
  )
    throw new Error("The target version changed outside its phase");
  for (const consumer of current.consumers)
    if (
      previous.consumers.find((item) => item.script === consumer.script)
        ?.version !== consumer.version
    )
      throw new Error(`${consumer.script} changed during the transfer`);
  if (
    !previous.objectSample ||
    !previous.apiVariables ||
    !current.objectSample ||
    !current.apiVariables
  )
    throw new Error("Continuity compares two phase receipts");
  for (const key of ["fileSHA256", "identitySetSHA256"])
    if (previous.objectSample[key] !== current.objectSample[key])
      throw new Error("The object sample changed during the transfer");
  const api = changedNames(previous.apiVariables, current.apiVariables);
  if (api.length) throw new Error(`API variables changed: ${api.join(", ")}`);
  const target =
    previous.targetVariables && current.targetVariables
      ? changedNames(previous.targetVariables, current.targetVariables)
      : [];
  if (target.length)
    throw new Error(`Target variables changed: ${target.join(", ")}`);
}

const RELEASE_STAGES = ["before", "admission", "api"] as const;

/**
 * Validates the command line. A release passes `--stage` and the committed
 * `--phase` (default `adopted`); Root passes `--phase` alone with the sample,
 * the summary and the effective-variable receipts.
 */
export function readbackRequest(values: {
  stage?: string;
  phase?: string;
  commit?: string;
  "object-sample"?: string;
  "object-summary"?: string;
  effective?: string[];
  previous?: string;
}) {
  const { stage, commit } = values;
  const sha = /^[0-9a-f]{40}$/.test(commit ?? "") ? commit : undefined;
  if (commit !== undefined && !sha)
    throw new Error("--commit must be a 40-character SHA");
  if (stage !== undefined) {
    const phase = (values.phase ?? "adopted") as ReleasePhase;
    if (!RELEASE_STAGES.includes(stage as (typeof RELEASE_STAGES)[number]))
      throw new Error("--stage must be before, admission or api");
    if (!(phase in RELEASE_PHASES))
      throw new Error(
        `A release publishes only ${Object.keys(RELEASE_PHASES).join(", ")}`,
      );
    if ((stage === "before") !== !sha)
      throw new Error(
        stage === "before"
          ? "--stage before serves no new commit; omit --commit"
          : "--commit must be the released 40-character SHA",
      );
    if (
      values["object-sample"] ||
      values["object-summary"] ||
      values.effective?.length ||
      values.previous
    )
      throw new Error("Sample, receipts and --previous are Root's phase proof");
    return {
      release: true,
      ...releaseCheck(stage as (typeof RELEASE_STAGES)[number], phase, sha),
    } as const;
  }
  const phase = values.phase as LivePhase;
  if (!(phase in LIVE_PHASES))
    throw new Error(
      `Pass --stage (release) or --phase (one of ${Object.keys(LIVE_PHASES).join(", ")})`,
    );
  const deploys = LIVE_PHASES[phase].deploys;
  if (deploys && !sha)
    throw new Error("--commit must be the deployed 40-character SHA");
  if (
    !values["object-sample"] ||
    !values["object-summary"] ||
    !values.effective?.length
  )
    throw new Error(
      "--phase requires --object-sample, --object-summary and --effective",
    );
  // Before any deploy, --commit pins the commit the API serves.
  const commits: Partial<Record<Side, string>> = sha
    ? { [deploys ?? "api"]: sha }
    : {};
  return { release: false, phases: [phase], commits } as const;
}

/**
 * The protected Eliza account's reader and the production Worker names, from
 * this tree's Wrangler configurations. It needs `CLOUDFLARE_ACCOUNT_ID` and a
 * read-capable `CLOUDFLARE_API_TOKEN`.
 */
export function productionAccount() {
  const config = (path: string) =>
    Bun.TOML.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
      account_id?: string;
      env?: { production?: { name?: string } };
    };
  const apiConfig = config("../api/wrangler.toml");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (account !== apiConfig.account_id || !token?.trim())
    throw new Error(
      "Readback requires the protected Eliza Cloudflare account and credential",
    );
  const read: CloudflareRead = async (path) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
      {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Cloudflare readback failed (HTTP ${response.status}): ${path}`,
      );
    }
    const body = (await response.json()) as Awaited<
      ReturnType<CloudflareRead>
    > & { success?: boolean };
    if (body?.success !== true)
      throw new Error(`Cloudflare readback was not successful: ${path}`);
    return body;
  };
  return {
    read,
    api: apiConfig.env?.production?.name ?? "",
    target:
      config("../admission-worker/wrangler.toml").env?.production?.name ?? "",
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { values } = parseArgs({
      options: {
        stage: { type: "string" },
        phase: { type: "string" },
        commit: { type: "string" },
        "object-sample": { type: "string" },
        "object-summary": { type: "string" },
        effective: { type: "string", multiple: true },
        previous: { type: "string" },
      },
    });
    const request = readbackRequest(values);
    const { read, api, target } = productionAccount();
    const effective = request.release
      ? undefined
      : effectiveVariables(
          (values.effective ?? []).map((path) => readFileSync(path, "utf8")),
        );
    const receipt = await verifyAnyPhase(request.phases, (phase) =>
      verifyProductionAdmission(read, {
        api,
        target,
        phase,
        commits: request.commits,
        effective,
      }),
    );
    if (!request.release) {
      const sampleText = readFileSync(
        values["object-sample"] as string,
        "utf8",
      );
      const { sample, identitySetSHA256 } = parseObjectSample(
        sampleText,
        readFileSync(values["object-summary"] as string, "utf8"),
      );
      receipt.objectSample = {
        fileSHA256: sha256(sampleText),
        identitySetSHA256,
        ...(await verifyObjectSample(read, sample)),
      };
      if (values.previous)
        requirePhaseContinuity(
          JSON.parse(readFileSync(values.previous, "utf8")),
          receipt,
        );
    }
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Production admission readback failed",
    );
    process.exitCode = 1;
  }
}
