// Runs the real application against its spec, with the generated module as the oracle (SPEC.md, "Conformance"):
// conform.ts runs it on each test/drivers/<name>.ts in the traces stage. Copied into gen/ as _conformance.ts for the
// types a driver is written to, so it imports nothing.

/** What the application did with an event. Anything else (a crash, a 500, a timeout) must throw. */
export type Outcome = "accepted" | "refused";

/** The only hand-written part: how to reach the real application. It may import the spec's types, never its code. */
export interface Driver<E, V> {
  /** Start from a fresh application: empty storage, nothing created. */
  reset(): void | Promise<void>;
  /**
   * Send `event` for the entity `key` through the application's own entry point, and say what it did. `by` is who
   * sent it, when the spec's transitions take a sender: sign in or open a session as them.
   */
  dispatch(key: string, event: E, by?: unknown): Outcome | Promise<Outcome>;
  /** What the application now holds or shows for `key`, read back through its own storage or interface. */
  observe(key: string): V | Promise<V>;
  /** Effects exposed by the application after its most recent dispatch, when it exposes them. */
  observeOutput?(key: string): unknown | Promise<unknown>;
  /**
   * Send an untrusted `raw` value for `key` as the network would, through the decoding `dispatch` skips. With it, the
   * check sends each event malformed (refused, nothing changes) and with an extra field and fields that change on a
   * second read (the same as the clean event).
   */
  receive?(key: string, raw: unknown, by?: unknown): Outcome | Promise<Outcome>;
}

export interface Options<S, V> {
  /** What of the spec's state the driver can observe; without it, `observe` returns the whole state. */
  view?: (state: S) => V;
  /** Entities the walks interleave, so that one leaking into another shows; one key for an application of one. */
  keys?: string[];
  /**
   * At most this many random walks after the journeys, within the fixed profile (conform.ts); 0 runs the journeys
   * only, as a slow driver (a browser) should.
   */
  walks?: number;
  steps?: number;
  seed?: number;
}

/** What the generated `gen/<name>.ts` gives the check. */
export interface Oracle<S, E> {
  initial: S;
  enabled(state: S, event: E, by?: any): boolean;
  step(state: S, event: E, by?: any): S | { state: S; out: unknown };
  parseState(raw: unknown): S | undefined;
  parseEvent(raw: unknown): E | undefined;
  parseSender?(raw: unknown): unknown;
}

/**
 * What `pnpm check` found for one spec: the events the simulator took or tried a guard with, a shortest journey to
 * each `sometimes` rule, and where the state holds sets. An event that came from someone carries them as `by`.
 */
export interface Found<E> {
  spec: string;
  source: string;
  sender: boolean;
  events: Sent<E>[];
  journeys: { story: string; rule: string; events: Sent<E>[] }[];
  shape: ComparisonShape;
  outputShape?: ComparisonShape;
  traces?: Sent<E>[][];
}
export type Sent<E> = E & { by?: unknown };

/** Events sent to the application, each for one entity: what a failure carries and `replay` takes. */
export type Trace<E> = [key: string, sent: Sent<E>][];

/** A disagreement between the application and its spec, with the fewest events that show it, as data to save and replay. */
export class ConformanceError<E = unknown> extends Error {
  readonly trace: Trace<E>;
  readonly seed: number;
  /** The journey or walk that found it, or "replay". */
  readonly origin: string;
  constructor(message: string, trace: Trace<E>, seed: number, origin: string) {
    super(message);
    this.name = "ConformanceError";
    this.trace = trace;
    this.seed = seed;
    this.origin = origin;
  }
}

/**
 * Run the journeys, the probes of a driver that can `receive`, then seeded random walks; throw a ConformanceError at
 * the first disagreement, shrunk to the fewest events that show it, or an Error at the first probe that fails.
 */
export async function check<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, driver: Driver<E, V>, options: Options<S, V> = {}) {
  const { differ, run, fail, seen, outcomes, keys, walks, steps, seed } = runner(oracle, found, driver, options);
  for (const j of found.journeys) {
    const trace: Trace<E> = j.events.map((e) => [keys[0], e]);
    if (await differ(trace)) await fail(`journey "${j.story}" / "${j.rule}"`, trace);
  }
  const probes = driver.receive ? await probe(oracle, found, driver, keys[0], run, options.view) : 0;
  // A walk mostly takes events the spec allows, so that it reaches deep states, and sometimes any event, so that refusals are tried.
  const random = rng(seed);
  for (let w = 0; w < walks; w++) {
    const model = new Map<string, S>();
    const trace: Trace<E> = [];
    for (let i = 0; i < steps; i++) {
      const key = keys[Math.floor(random() * keys.length)];
      const state = model.get(key) ?? oracle.initial;
      const allowed = found.events.filter(({ by, ...e }) => oracle.enabled(state, e as E, by));
      const pool = allowed.length && random() < 0.75 ? allowed : found.events;
      const sent = pool[Math.floor(random() * pool.length)];
      const { by, ...event } = sent;
      trace.push([key, sent]);
      const after = transition(oracle, found, state, event, by);
      if (typeof after === "string") throw new Error(after);
      model.set(key, after.after);
    }
    if (await differ(trace)) await fail(`walk ${w + 1} of seed ${seed}`, trace);
  }

  return { journeys: found.journeys.length, probes, walks, observed: seen.size, outcomes: [...outcomes], effects: found.outputShape ? driver.observeOutput ? "checked" : "not observed" : "none" };
}

/**
 * Run exactly `trace`, saved as `from`, through the application; throw a ConformanceError if it still disagrees, and
 * an Error if it holds an event the spec no longer has, which only a person can bring up to date or delete.
 */
export async function replay<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, driver: Driver<E, V>, trace: Trace<E>, options: Options<S, V> = {}, from = "a saved trace") {
  const gone = trace.find(([, { by, ...event }]) => oracle.parseEvent(event) === undefined || (found.sender ? oracle.parseSender?.(by) === undefined : by !== undefined));
  if (gone) throw new Error(`the spec has outgrown ${from}: ${show(gone[1])} is not one of its events now; bring the trace up to date, or delete it`);
  const why = await runner(oracle, found, driver, options).differ(trace);
  if (why) throw new ConformanceError(`conformance to ${found.source}: ${from}, replayed, ${trace.length} events:\n${lines(trace)}\n${why}`, trace, options.seed ?? 1, "replay");
}

/**
 * Each kind of event, after the shortest journey prefix that allows it: malformed, it must be refused and change
 * nothing; with an extra field and fields that change on a second read, it must do what the clean event does, as
 * the application copies what it decodes (SPEC.md, "Using the generated code"). Returns how many were sent.
 */
async function probe<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, driver: Driver<E, V>, key: string,
  run: (trace: Trace<E>) => Promise<Map<string, S> | string>, view?: (state: S) => V) {
  const prefixes: Sent<E>[][] = [[], ...found.journeys.flatMap((j) => j.events.map((_, i) => j.events.slice(0, i + 1)))];
  const after = (prefix: Sent<E>[]) => prefix.reduce<S>((s, { by, ...e }) => { const t = transition(oracle, found, s, e, by); return typeof t === "string" ? s : t.after; }, oracle.initial);
  let sent = 0;
  const typeOf = (e: unknown) => (e as { type: string }).type;
  for (const type of new Set(found.events.map(typeOf))) {
    const samples = found.events.filter((e) => typeOf(e) === type);
    const [prefix, sample] = prefixes.flatMap((p) => samples.filter(({ by, ...e }) => oracle.enabled(after(p), e as E, by)).map((e) => [p, e] as const))[0] ?? [[], samples[0]] as const;
    const { by, ...event } = sample as Sent<E> & Record<string, unknown>;
    const model = await run(prefix.map((e) => [key, e]));
    if (typeof model === "string") throw new Error(`conformance to ${found.source}: before probing ${type}: ${model}`);
    let state: S = model.get(key)!;
    const fields = Object.keys(event).filter((f) => f !== "type");
    const malformed = [{ ...event, type: `${type}?` }, ...fields.flatMap((f) => [{ ...event, [f]: 1.5 }, { ...event, [f]: 2 ** 53 }, Object.fromEntries(Object.entries(event).filter(([g]) => g !== f))])];
    const read = new Set<string>();
    const sly = Object.defineProperties({ ...event, unexpected: "ignored" }, Object.fromEntries(fields.map((f) => [f, {
      enumerable: true, get: () => read.has(f) ? changed(event[f]) : (read.add(f), event[f]),
    }])));
    for (const raw of [...malformed.filter((raw) => oracle.parseEvent(raw) === undefined), sly]) {
      const at = `conformance to ${found.source}: probe ${raw === sly ? `${show(event)} with an extra field and fields that change when read again` : show(raw)}, after ${prefix.length} events of a journey`;
      const expected = raw === sly ? transition(oracle, found, state, event, by) : { allowed: false, after: state };
      if (typeof expected === "string") throw new Error(`${at}: ${expected}`);
      let did: unknown;
      try { did = await driver.receive!(key, raw, by); } catch (error) { throw new Error(`${at}: the application failed: ${error instanceof Error ? error.message : show(error)}`, { cause: error }); }
      sent++;
      if (did !== (expected.allowed ? "accepted" : "refused")) throw new Error(`${at}: the application ${show(did)} it, where the spec ${expected.allowed ? "accepts" : "refuses"} it`);
      const problem = compareObservation(oracle, found, expected.after, await driver.observe(key), view);
      if (problem) throw new Error(`${at}: ${key} ${problem}`);
      state = expected.after;
    }
  }
  return sent;
}

/** A value that is not `x`, as a field read a second time gives it. */
const changed = (x: unknown) => typeof x === "number" ? x + 1_000_000 : typeof x === "string" ? `${x}?` : typeof x === "boolean" ? !x : undefined;

const lines = <E>(trace: Trace<E>) => trace.map(([k, e]) => `  ${k} ${show(e)}`).join("\n");

/** What `check` and `replay` share: running a trace through the driver beside the oracle, and shrinking one that disagrees. */
function runner<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, driver: Driver<E, V>, options: Options<S, V>) {
  const { view, keys = ["a", "b"], walks = 1, steps = 20, seed = 1 } = options;
  if (!found.events.length) throw new Error(`the simulator found no events of ${found.source}`);
  if (!keys.length || keys.some((key) => typeof key !== "string" || !key) || new Set(keys).size !== keys.length) throw new Error("conformance keys must be distinct nonempty strings");
  for (const [name, count] of Object.entries({ walks, steps, seed })) if (!Number.isSafeInteger(count) || count < 0) throw new Error(`conformance ${name} must be a nonnegative safe integer`);
  const seen = new Set<string>();
  const outcomes = new Set<Outcome>();

  /** The first way the application differs from the spec along `trace`, or else the spec's state of each key after it. */
  const run = async (trace: Trace<E>): Promise<Map<string, S> | string> => {
    await driver.reset();
    const model = new Map<string, S>();
    for (const key of keys) {
      const raw = await driver.observe(key);
      const problem = compareObservation(oracle, found, oracle.initial, raw, view);
      if (problem) return `initial ${key}: ${problem}`;
      model.set(key, oracle.initial);
    }
    for (const [i, [key, sent]] of trace.entries()) {
      const at = `event ${i + 1}, ${key} ${show(sent)}`;
      const { by, ...rawEvent } = sent as Sent<E> & Record<string, unknown>;
      const before = model.get(key)!;
      const applied = transition(oracle, found, before, rawEvent, by);
      if (typeof applied === "string") return `${at}: ${applied}`;
      const { event, allowed, after, out } = applied;
      const did = await driver.dispatch(key, event, by);
      if (did !== "accepted" && did !== "refused") return `${at}: dispatch returned ${show(did)}; it returns "accepted" or "refused" and throws otherwise`;
      outcomes.add(did);
      if (allowed !== (did === "accepted")) return `${at}: the spec ${allowed ? "allows" : "refuses"} it, the application ${did} it`;
      if (found.outputShape && driver.observeOutput) {
        const actual = await driver.observeOutput(key);
        if (canonical(actual, found.outputShape) !== canonical(out, found.outputShape)) return `${at}: emitted effects differ from the spec`;
      }
      model.set(key, after);
      for (const [k, state] of model) {
        const raw = await driver.observe(k);
        const problem = compareObservation(oracle, found, state, raw, view);
        if (problem) return `${at}: ${k} ${problem}`;
        seen.add(canonical(raw, view ? "scalar" : found.shape));
      }
    }
    return model;
  };
  const differ = async (trace: Trace<E>) => { const r = await run(trace); return typeof r === "string" ? r : undefined; };
  /** Drop events while the disagreement stays: any subsequence is still a test, since the spec also says what is refused. */
  const fail = async (what: string, trace: Trace<E>) => {
    for (let i = trace.length - 1; i >= 0; i--) {
      const shorter = trace.toSpliced(i, 1);
      if (await differ(shorter)) trace = shorter;
    }
    throw new ConformanceError(`conformance to ${found.source}: ${what}, shrunk to ${trace.length} events:\n${lines(trace)}\n${await differ(trace)}`, trace, seed, what);
  };

  return { differ, run, fail, seen, outcomes, keys, walks, steps, seed };
}

/** The state type, resolved by the generator so sets are sorted only in the variant that owns them. */
export type ComparisonShape = "scalar" | { set: ComparisonShape } | { list: ComparisonShape } | { map: ComparisonShape } | { fields: Record<string, ComparisonShape> } | { variants: Record<string, ComparisonShape> };

export function canonical(value: unknown, shape: ComparisonShape): string {
  const sort = (value: any, shape: ComparisonShape): any => {
    if (shape !== "scalar" && "variants" in shape) shape = shape.variants[value?.tag] ?? "scalar";
    if (Array.isArray(value)) {
      const element = shape !== "scalar" && "set" in shape ? shape.set : shape !== "scalar" && "list" in shape ? shape.list : "scalar";
      const items = value.map((item) => sort(item, element));
      return shape !== "scalar" && "set" in shape ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key,
      sort(value[key], shape !== "scalar" && "fields" in shape ? shape.fields[key] ?? "scalar" : shape !== "scalar" && "map" in shape ? shape.map : "scalar")]));
    return value;
  };
  const result = JSON.stringify(sort(value, shape));
  if (result === undefined) throw new Error("an observation must be a JSON value");
  return result;
}

const show = (x: unknown) => JSON.stringify(x) ?? String(x);

/** A small seeded generator, so that a walk repeats exactly. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** A recorded line either starts from a state or applies an event; state observations may be sparse. */
export interface Line { event?: unknown; by?: unknown; state?: unknown; out?: unknown }

/** Validate an input once for both driver and recorded-trace conformance. */
export function transition<S, E>(oracle: Oracle<S, E>, found: Found<E>, before: S, raw: unknown, by: unknown): { event: E; allowed: boolean; after: S; out?: unknown } | string {
  const event = oracle.parseEvent(raw);
  if (event === undefined) return `${show(raw)} is not an event of the spec`;
  if (found.sender ? by === undefined || !oracle.parseSender || oracle.parseSender(by) === undefined : by !== undefined)
    return found.sender ? "the event needs a valid sender" : "the spec's events have no sender";
  const result = oracle.step(before, event, by);
  const { state: after, out } = found.outputShape ? result as { state: S; out: unknown } : { state: result as S, out: undefined };
  return { event, allowed: oracle.enabled(before, event, by), after, out };
}

/** Compare what the real application exposed, keeping sets independent of their iteration order. */
export function compareObservation<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, expected: S, raw: unknown, view?: (state: S) => V): string | undefined {
  const actual = view ? raw : oracle.parseState(raw);
  if (actual === undefined) return `reads back as ${show(raw)}, which is not a state the spec allows`;
  const want = canonical(view ? view(expected) : expected, view ? "scalar" : found.shape);
  const have = canonical(actual, view ? "scalar" : found.shape);
  return want === have ? undefined : `should be ${want}, but the application has ${have}`;
}

/** The first disagreement in a recorded trace. At least one real state must have been observed. */
export function departure<S, E>(oracle: Oracle<S, E>, found: Found<E>, lines: unknown[]): { line: number; why: string } | undefined {
  let current = oracle.initial;
  let observed = 0;
  for (const [i, raw] of lines.entries()) {
    const fail = (why: string) => ({ line: i + 1, why });
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["event", "by", "state", "out"].includes(key)))
      return fail(`${show(raw)} is not {event?, by?, state?, out?}`);
    const line = raw as Line;
    if (line.event === undefined) {
      if (line.by !== undefined || Object.hasOwn(line, "out")) return fail("a start line has no sender or emitted effects");
      if (Object.hasOwn(line, "state")) {
        const state = oracle.parseState(line.state);
        if (state === undefined) return fail(`the program starts from an invalid state ${show(line.state)}`);
        current = state;
        observed++;
      } else current = oracle.initial;
      continue;
    }
    const applied = transition(oracle, found, current, line.event, line.by);
    if (typeof applied === "string") return fail(applied);
    current = applied.after;
    if (Object.hasOwn(line, "out")) {
      if (!found.outputShape) return fail("this spec does not emit effects");
      if (canonical(line.out, found.outputShape) !== canonical(applied.out, found.outputShape)) return fail("emitted effects differ from the spec");
    }
    if (Object.hasOwn(line, "state")) {
      observed++;
      const problem = compareObservation(oracle, found, current, line.state);
      if (problem) return fail(problem);
    }
  }
  if (!observed) return { line: Math.max(1, lines.length), why: "the trace contains no observed state" };
}
