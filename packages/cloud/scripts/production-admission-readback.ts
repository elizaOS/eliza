/**
 * Fail-closed Cloudflare readback of the production admission namespace.
 *
 * Releases check the adopted steady state (`--stage`). Root checks each
 * transfer phase (`--phase`): the expected owner, every binding of the
 * namespace in the account, API and target variable parity, the saved object
 * sample and continuity with the previous phase's receipt.
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

// Scripts outside this repository that bind the namespace by the API's class.
// Every readback proves they still resolve it through the API, whose retained
// tombstone forwards to the owner. Rebinding or deleting one is a reviewed
// change to this list; anything else stops the readback.
export const KNOWN_EXTERNAL_CONSUMERS = [
  { script: "diag-admission-caller-9bd05690", binding: "PRODUCTION" },
] as const;

// Gate policy flags the gate reads. Both Workers keep them unset or equal.
export const GATE_POLICY_VARIABLES = [
  "INFERENCE_FUNDED_BUDGET_ADMISSION",
  "INFERENCE_RATE_POLICY_ADMISSION",
] as const;

// The live state after each step, in execution order. `owner` owns the
// namespace; `apiGate` serves the API's binding; the target's own binding is
// `bound`, `unbound` (none) or the target is `absent`. `deploys` is the one
// Worker the step uploads.
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
export interface Receipt {
  phase: LivePhase;
  namespace: string;
  owner: string;
  api: { script: string; version: string; commit?: unknown };
  target: { script: string; version: string; commit?: unknown } | null;
  consumers: { script: string; binding: string; version: string }[];
  namespaceBindings?: string[];
  parityVariables?: string[];
  objectSample?: Record<string, unknown>;
}

const NAMESPACE_PAGE_SIZE = 100;
const NAMESPACE_PAGE_LIMIT = 50;

/** Every namespace, or an error: each page must carry counts that add up. */
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
    if (namespaces.size === total) return [...namespaces.values()];
    if (namespaces.size > total || result.length < NAMESPACE_PAGE_SIZE)
      throw new Error(
        "Cloudflare namespace pages do not add up to their total",
      );
  }
  throw new Error(
    `Cloudflare namespace listing did not finish within ${NAMESPACE_PAGE_LIMIT} pages`,
  );
}

async function activeVersion(read: CloudflareRead, script: string) {
  const deployments = (
    (await read(`/workers/scripts/${script}/deployments`)).result as {
      deployments?: {
        created_on: string;
        versions?: { version_id: string; percentage: number }[];
      }[];
    }
  )?.deployments;
  if (!deployments?.length)
    throw new Error(`${script} has no Cloudflare deployment`);
  const [active] = deployments.toSorted(
    (left, right) => Date.parse(right.created_on) - Date.parse(left.created_on),
  );
  if (active.versions?.length !== 1 || active.versions[0].percentage !== 100)
    throw new Error(`${script} must serve exactly one version at 100%`);
  const id = active.versions[0].version_id;
  const version = (await read(`/workers/scripts/${script}/versions/${id}`))
    .result as { id?: string; resources?: { bindings?: Binding[] } };
  const bindings = version?.resources?.bindings;
  if (version?.id !== id || !Array.isArray(bindings))
    throw new Error(`${script} version ${id} did not read back its bindings`);
  return { id, bindings };
}

function named(bindings: Binding[], name: string) {
  const matches = bindings.filter((binding) => binding.name === name);
  if (matches.length > 1) throw new Error(`Duplicate binding ${name}`);
  return matches[0];
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
      `${holder} ${String(binding?.name ?? "binding")} must resolve ${PRODUCTION_ADMISSION_NAMESPACE_ID} through ${servedBy}`,
    );
}

function requireCommit(bindings: Binding[], script: string, commit: string) {
  const deployed = named(bindings, "ELIZA_DEPLOY_COMMIT");
  if (deployed?.type !== "plain_text" || deployed.text !== commit)
    throw new Error(`${script} does not serve commit ${commit}`);
}

/** Bindings anywhere in the account that reach the namespace. */
async function namespaceBindings(
  read: CloudflareRead,
  scripts: string[],
  owners: string[],
) {
  const found: string[] = [];
  for (const script of scripts) {
    const bindings = (
      (await read(`/workers/scripts/${script}/settings`)).result as {
        bindings?: Binding[];
      }
    )?.bindings;
    if (!Array.isArray(bindings))
      throw new Error(`${script} settings did not read back its bindings`);
    for (const binding of bindings)
      if (
        binding.type === "durable_object_namespace" &&
        (binding.namespace_id === PRODUCTION_ADMISSION_NAMESPACE_ID ||
          (binding.class_name === GATE &&
            owners.includes(String(binding.script_name ?? script))))
      )
        found.push(`${script}/${String(binding.name)}`);
  }
  return found.sort();
}

/**
 * The target's variables are copies of the API's. Compare every one it
 * carries, plus the gate policy flags, on the active versions.
 */
function requireVariableParity(api: Binding[], target: Binding[]) {
  const value = (bindings: Binding[], name: string) => {
    const binding = named(bindings, name);
    if (binding && binding.type !== "plain_text")
      throw new Error(`${name} is not a plain-text variable`);
    return binding?.text;
  };
  const names = new Set<string>(GATE_POLICY_VARIABLES);
  for (const binding of target)
    if (binding.type === "plain_text") names.add(String(binding.name));
  names.delete("ELIZA_DEPLOY_COMMIT");
  for (const name of names)
    if (value(api, name) !== value(target, name))
      throw new Error(`Live variable differs between API and target: ${name}`);
  return [...names].sort();
}

/**
 * Proves one live state. `commits` names the commit each listed Worker must
 * serve. `inventory` (Root's phase proof) also scans every script's bindings
 * for the namespace and requires API and target variable parity.
 */
export async function verifyProductionAdmission(
  read: CloudflareRead,
  options: {
    api: string;
    target: string;
    phase: LivePhase;
    commits?: Partial<Record<Side, string>>;
    inventory?: boolean;
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

  const scripts = (await read("/workers/scripts")).result;
  if (
    !Array.isArray(scripts) ||
    scripts.some((script) => typeof script?.id !== "string")
  )
    throw new Error("Cloudflare did not return the script list");
  const scriptIds: string[] = scripts.map((script) => script.id);
  if (scriptIds.includes(options.target) !== (expected.target !== "absent"))
    throw new Error(
      `${options.phase} requires ${options.target} to ${expected.target === "absent" ? "not exist" : "exist"}`,
    );

  const api = await activeVersion(read, options.api);
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
  for (const consumer of KNOWN_EXTERNAL_CONSUMERS) {
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
      commit: named(api.bindings, "ELIZA_DEPLOY_COMMIT")?.text,
    },
    target: target
      ? {
          script: options.target,
          version: target.id,
          commit: named(target.bindings, "ELIZA_DEPLOY_COMMIT")?.text,
        }
      : null,
    consumers,
  };
  if (!options.inventory) return receipt;

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
  if (target)
    receipt.parityVariables = requireVariableParity(
      api.bindings,
      target.bindings,
    );
  return receipt;
}

/**
 * Root's saved sample: `[{id, hasStoredData}]` or `{namespace, objects}`.
 * With the public summary, its counts must match the saved receipt.
 */
export function parseObjectSample(text: string, summaryText?: string) {
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
  if (summaryText !== undefined) {
    const summary = JSON.parse(summaryText);
    if (
      summary?.namespace !== PRODUCTION_ADMISSION_NAMESPACE_ID ||
      summary.observedObjects !== sample.size ||
      summary.storedDataObjects !== [...sample.values()].filter(Boolean).length
    )
      throw new Error("Object sample does not match its saved summary");
  }
  return sample;
}

const OBJECT_PAGE_SIZE = 10_000;
const OBJECT_PAGE_LIMIT = 100;

/**
 * Finds every sampled object by ID in the namespace, wherever enumeration
 * lists it. A sampled object that disappears or loses its stored data stops
 * the transfer; one that gains stored data is ordinary traffic and counted.
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
      if (before && !object.hasStoredData)
        throw new Error("A sampled object lost its stored data");
      if (!before && object.hasStoredData) gainedStoredData += 1;
    }
    if (!remaining.size)
      return {
        sampled: sample.size,
        storedDataBefore: [...sample.values()].filter(Boolean).length,
        gainedStoredData,
        listed: listed.size,
        pages: page,
      };
    const next = info.cursor;
    if (typeof next !== "string" || !next)
      throw new Error(
        `${remaining.size} sampled objects are missing from the namespace`,
      );
    if (cursors.has(next)) throw new Error("Cloudflare object cursor repeated");
    cursors.add(next);
    cursor = next;
  }
  throw new Error(
    `Cloudflare object listing did not reach every sampled object within ${OBJECT_PAGE_LIMIT} pages`,
  );
}

/**
 * A phase follows the previous receipt or repeats it. Only the Worker the
 * phase deploys may change version; every known consumer stays on its version.
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
        previous: { type: "string" },
      },
    });
    const { stage, phase, commit } = values;
    const releaseStages = ["before", "admission", "api"];
    if (stage !== undefined && phase !== undefined)
      throw new Error("Pass either --stage or --phase");
    if (stage !== undefined && !releaseStages.includes(stage))
      throw new Error("--stage must be before, admission or api");
    if (phase !== undefined && !(phase in LIVE_PHASES))
      throw new Error(
        `--phase must be one of ${Object.keys(LIVE_PHASES).join(", ")}`,
      );
    if (stage === undefined && phase === undefined)
      throw new Error("Pass --stage (release) or --phase (transfer)");
    const livePhase = (phase ?? "adopted") as LivePhase;
    const needsCommit = stage
      ? stage !== "before"
      : LIVE_PHASES[livePhase].deploys !== undefined;
    if (needsCommit !== /^[0-9a-f]{40}$/.test(commit ?? ""))
      throw new Error(
        needsCommit
          ? "--commit must be the deployed 40-character SHA"
          : "This readback serves no new commit; omit --commit",
      );
    if (phase !== undefined && !values["object-sample"])
      throw new Error("--phase requires Root's saved --object-sample");
    const commits: Partial<Record<Side, string>> =
      stage === "admission"
        ? { target: commit }
        : stage === "api"
          ? { target: commit, api: commit }
          : phase !== undefined && LIVE_PHASES[livePhase].deploys
            ? { [LIVE_PHASES[livePhase].deploys as Side]: commit }
            : {};
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
    const receipt = await verifyProductionAdmission(read, {
      api: apiConfig.env?.production?.name ?? "",
      target:
        config("../admission-worker/wrangler.toml").env?.production?.name ?? "",
      phase: livePhase,
      commits,
      inventory: phase !== undefined,
    });
    if (phase !== undefined) {
      const sampleText = readFileSync(
        values["object-sample"] as string,
        "utf8",
      );
      const sample = parseObjectSample(
        sampleText,
        values["object-summary"] &&
          readFileSync(values["object-summary"], "utf8"),
      );
      receipt.objectSample = {
        fileSHA256: createHash("sha256").update(sampleText).digest("hex"),
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
