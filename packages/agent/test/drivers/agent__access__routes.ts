// spec/agent/access/routes.md, "Story: Admit only the routes a product lists"
import type { Driver } from "../../gen/agent__access__routes.conformance.ts";
import type { Accept, Admission, Answer, Flaw, Group, Method, Request, Route, RouteGate as GateState, RouteList, Table } from "../../gen/agent__access__routes.ts";
import { type RouteGate, type RouteRequest, routeGate } from "../../src/access/routes.vibe";

const verbs: Record<Method, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE" };
const overLimit = 2049;

interface Realised {
  readonly ids: ReadonlyMap<string, string>;
  readonly values: ReadonlyMap<string, string>;
  readonly back: ReadonlyMap<string, string>;
}

const escape = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

const realise = (pattern: string, texts: readonly string[]): string =>
  `(?:${[...new Set(texts)].map((text) => `${escape(text)}|`).join("")}(?!)${escape(pattern)})`;

export function realisation(routes: RouteList, request?: Request): Realised {
  const back = new Map<string, string>();
  const ids = new Map(routes.flatMap((group) => group.id === "" ? [] : [group.id]).map((id) => {
    const wire = realise(id, (request?.segments ?? []).filter((segment) => segment.fits.includes(id)).map((segment) => segment.text));
    back.set(wire, id);
    return [id, wire] as const;
  }));
  const patterns = routes.flatMap((group) => group.routes.flatMap((route) =>
    route.query.flatMap(({ accepts }) => accepts.tag === "Matching" ? [accepts.pattern] : [])));
  const values = new Map(patterns.map((pattern) => {
    const wire = realise(pattern, (request?.query ?? []).filter((pair) => pair.fits.includes(pattern)).map((pair) => pair.value));
    back.set(wire, pattern);
    return [pattern, wire] as const;
  }));
  return { ids, values, back };
}

const wireAccept = (accepts: Accept, realised: Realised) => {
  switch (accepts.tag) {
    case "AnyValue": return { kind: "any" };
    case "Matching": return { kind: "pattern", pattern: realised.values.get(accepts.pattern) ?? accepts.pattern };
    case "Pinned": return { kind: "pinned", value: accepts.value };
  }
};

const wireRoute = (route: Route, realised: Realised) => ({
  method: verbs[route.method],
  path: `/${route.path.map((piece) => piece.tag === "Literal" ? piece.text : "{param}").join("/")}`,
  ...(route.delivery === "Streamed" ? { stream: true } : {}),
  query: route.query.map(({ key, accepts }) => ({ key, accepts: wireAccept(accepts, realised) })),
  ...(route.limit.tag === "AtMost" ? { maxBodyBytes: route.limit.bytes } : {}),
});

export function wireList(routes: RouteList, realised: Realised): unknown {
  return routes.map((group: Group) => ({
    prefixes: group.prefixes.map((prefix) => prefix.length === 0 ? "" : `/${prefix.join("/")}`),
    ...(group.id === "" ? {} : { id: realised.ids.get(group.id) ?? group.id }),
    routes: group.routes.map((route) => wireRoute(route, realised)),
  }));
}

const component = (text: string): string => encodeURIComponent(text).replaceAll("%2B", "+");

const nextQuery = (target: string): string => target.includes("?") ? "&" : "?";

function withFlaw(target: string, flaw: Flaw): string {
  switch (flaw) {
    case "Backslash": return `${target}\\`;
    case "Fragment": return `${target}#part`;
    case "UnsafeCharacter": return `${target} `;
    case "PercentInPath": return `/%41${target.slice(1)}`;
    case "MalformedEscape": return `${target}${nextQuery(target)}%zz=1`;
    case "PathTooLong": return `${target}${nextQuery(target)}pad=${"a".repeat(overLimit)}`;
  }
}

export function rawTarget(request: Request): string {
  const path = `/${request.segments.map((segment) => segment.text).join("/")}`;
  const query = request.query.map(({ key, value }) => `${component(key)}=${component(value)}`).join("&");
  return request.flaws.reduce(withFlaw, query === "" ? path : `${path}?${query}`);
}

function rawBody(body: Request["body"]): Uint8Array | undefined {
  switch (body.tag) {
    case "NoBody": return undefined;
    case "NotAnObject": return new TextEncoder().encode("[]");
    case "JsonObject": return new TextEncoder().encode(`{${" ".repeat(Math.max(0, body.size - 2))}}`);
  }
}

export const rawRequest = (request: Request): RouteRequest => ({
  method: verbs[request.method],
  target: rawTarget(request),
  streamed: request.delivery === "Streamed",
  body: rawBody(request.body),
});

const modelRouteBack = (route: Route, back: ReadonlyMap<string, string>): Route => ({
  ...route,
  query: route.query.map((rule) => rule.accepts.tag === "Matching"
    ? { ...rule, accepts: { tag: "Matching", pattern: back.get(rule.accepts.pattern) ?? rule.accepts.pattern } }
    : rule),
});

const admissionBack = (admission: Admission, back: ReadonlyMap<string, string>): Admission =>
  admission.tag === "Admitted" ? { tag: "Admitted", route: modelRouteBack(admission.route, back) } : admission;

function tableBack(table: Table, back: ReadonlyMap<string, string>): Table {
  if (table.tag !== "Loaded") return table;
  return { tag: "Loaded", groups: table.groups.map((group) => ({ ...group, id: back.get(group.id) ?? group.id, routes: group.routes.map((route) => modelRouteBack(route, back)) })) };
}

const answerBack = (answer: Answer, back: ReadonlyMap<string, string>): Answer =>
  answer.tag === "Answered" ? { tag: "Answered", admission: admissionBack(answer.admission, back) } : answer;

export const stateBack = (state: GateState, back: ReadonlyMap<string, string>): GateState =>
  ({ table: tableBack(state.table, back), answer: answerBack(state.answer, back) });

interface Held {
  readonly gate: RouteGate;
  routes: RouteList | undefined;
  back: ReadonlyMap<string, string>;
  out: Admission[];
}

const held = new Map<string, Held>();

const holding = (key: string): Held => {
  const found = held.get(key);
  if (found) return found;
  const fresh: Held = { gate: routeGate(), routes: undefined, back: new Map(), out: [] };
  held.set(key, fresh);
  return fresh;
};

export const driver: Driver = {
  reset: () => held.clear(),
  dispatch: (key, event) => {
    const entity = holding(key);
    if (event.type === "load") {
      const realised = realisation(event.routes);
      entity.routes = event.routes;
      entity.back = realised.back;
      entity.gate.load(wireList(event.routes, realised));
      entity.out = [];
      return "accepted";
    }
    if (entity.routes !== undefined) {
      const realised = realisation(entity.routes, event.request);
      entity.back = realised.back;
      entity.gate.load(wireList(entity.routes, realised));
    }
    entity.out = [admissionBack(entity.gate.admit(rawRequest(event.request)), entity.back)];
    return "accepted";
  },
  observe: (key) => stateBack(holding(key).gate.state(), holding(key).back),
  observeOutput: (key) => holding(key).out,
};
