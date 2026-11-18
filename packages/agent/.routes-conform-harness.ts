import { check } from "../../vibestack/conformance.ts";
import * as oracle from "./gen/agent__access__routes.ts";
import { driver } from "./test/drivers/agent__access__routes.ts";

const L = (text: string) => ({ tag: "Literal", text });
const P = { tag: "Param" };
const route = (method: string, path: object[], extra: object = {}) =>
  ({ method, delivery: "Buffered", path, query: [], limit: { tag: "AnySize" }, ...extra });
const tasks = { prefixes: [["api", "records"]], id: "[a-z]+", routes: [
  route("Get", [L("api"), L("records"), L("tasks")], { query: [
    { key: "ownerVisibleOnly", accepts: { tag: "Pinned", value: "1" } },
    { key: "view", accepts: { tag: "AnyValue" } },
    { key: "tz", accepts: { tag: "Matching", pattern: "[A-Za-z+/]+" } },
  ] }),
  route("Get", [L("api"), L("records"), P]),
] };
const calendar = { prefixes: [["api", "records", "calendar"]], id: "[0-9]+", routes: [
  route("Delete", [L("api"), L("records"), L("calendar"), P]),
  route("Post", [L("api"), L("records"), L("calendar"), P], { limit: { tag: "AtMost", bytes: 10 } }),
] };
const flat = { prefixes: [[]], id: oracle.flatParam, routes: [
  route("Get", [L("api"), L("status")]),
  route("Post", [L("api"), L("c"), P, L("stream")], { delivery: "Streamed" }),
  route("Post", [L("api"), L("c"), P], { limit: { tag: "AtMost", bytes: 8 } }),
] };
const loads = [
  [tasks, calendar, flat], [tasks], [flat], [],
  [tasks, { ...calendar, prefixes: [["api", "records"]] }],
  [{ ...tasks, prefixes: [["api", ".."]] }],
  [{ ...flat, routes: [route("Get", [L("api"), L("status")], { limit: { tag: "AtMost", bytes: 0 } })] }],
].map((routes) => ({ type: "load", routes }));

const seg = (text: string, fits: string[] = []) => ({ text, fits });
const req = (method: string, segments: object[], extra: object = {}) =>
  ({ type: "admit", request: { method, delivery: "Buffered", segments, query: [], flaws: [], body: { tag: "NoBody" }, ...extra } });
const api = seg("api"), rec = seg("records"), cal = seg("calendar");
const pair = (key: string, value: string, fits: string[] = []) => ({ key, value, fits });
const admits = [
  req("Get", [api, seg("status")]),
  req("Get", [api, seg("status")], { body: { tag: "JsonObject", size: 2 } }),
  req("Get", [api, seg("status")], { query: [pair("x", "1")] }),
  req("Post", [api, seg("c"), seg("c1", [oracle.flatParam]), seg("stream")], { delivery: "Streamed", body: { tag: "JsonObject", size: 30 } }),
  req("Post", [api, seg("c"), seg("c1", [oracle.flatParam]), seg("stream")], { body: { tag: "JsonObject", size: 3 } }),
  req("Post", [api, seg("c"), seg("c1", [oracle.flatParam])], { body: { tag: "JsonObject", size: 8 } }),
  req("Post", [api, seg("c"), seg("c1", [oracle.flatParam])], { body: { tag: "JsonObject", size: 9 } }),
  req("Post", [api, seg("c"), seg("c1")], { body: { tag: "JsonObject", size: 2 } }),
  req("Post", [api, seg("c"), seg("c1", [oracle.flatParam])], { body: { tag: "NotAnObject" } }),
  req("Get", [api, rec, seg("tasks")], { query: [pair("ownerVisibleOnly", "1"), pair("view", "a b&c=d+e")] }),
  req("Get", [api, rec, seg("tasks")], { query: [pair("view", "week")] }),
  req("Get", [api, rec, seg("tasks")], { query: [pair("ownerVisibleOnly", "0")] }),
  req("Get", [api, rec, seg("tasks")], { query: [pair("ownerVisibleOnly", "1"), pair("ownerVisibleOnly", "1")] }),
  req("Get", [api, rec, seg("tasks")], { query: [pair("ownerVisibleOnly", "1"), pair("tz", "Etc/GMT+3", ["[A-Za-z+/]+"])] }),
  req("Get", [api, rec, seg("tasks")], { query: [pair("ownerVisibleOnly", "1"), pair("tz", "UTC 1")] }),
  req("Get", [api, rec, seg("abc", ["[a-z]+"])]),
  req("Get", [api, rec, seg("abc")]),
  req("Get", [api, rec, cal]),
  req("Delete", [api, rec, cal, seg("42", ["[0-9]+"])]),
  req("Delete", [api, rec, cal, seg("42", ["[0-9]+"])], { body: { tag: "JsonObject", size: 2 } }),
  req("Post", [api, rec, cal, seg("42", ["[0-9]+"])], { body: { tag: "JsonObject", size: 11 } }),
  req("Post", [api, rec, cal, seg("42", ["[0-9]+"])], { body: { tag: "JsonObject", size: 10 } }),
  req("Get", [api, seg("..")]),
  req("Get", [api, seg("")]),
  req("Get", [api, seg("st%61tus")]),
  ...(["Backslash", "Fragment", "UnsafeCharacter", "PercentInPath", "MalformedEscape", "PathTooLong"] as const)
    .map((flaw) => req("Get", [api, seg("status")], { flaws: [flaw] })),
  req("Get", [api, rec, seg("tasks")], { query: [pair("ownerVisibleOnly", "1")], flaws: ["Fragment", "PathTooLong"] }),
];

const found = { spec: "agent/access/routes", source: "spec/agent/access/routes.md", sender: false, shape: "scalar" as const,
  outputShape: "scalar" as const, events: [...loads, ...admits] as never[], journeys: [] };
const result = await check(oracle as never, found, driver as never, { walks: Number(process.argv[2] ?? 200), steps: 30, seed: 7, keys: ["a", "b"] });
process.stdout.write(`${JSON.stringify(result)}\n`);
