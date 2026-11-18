import { it, expect } from "vitest"
import * as o from "../../gen/agent__access__routes.ts"
import { driver } from "../drivers/agent__access__routes.ts"
let seed = 12345
const r = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
const pick = <T,>(xs: readonly T[]): T => xs[r(xs.length)]
const texts = ["a", "b", "api", "x", "", ".", "a+b", "é"]
const ids = ["[a-z]+", "[0-9]+", o.flatParam]
const pats = ["[a-z]+", "[0-9]+"]
const methods: o.Method[] = ["Get", "Post", "Delete"]
const piece = (): o.Piece => r(3) === 0 ? { tag: "Param" } : { tag: "Literal", text: pick(["a", "b", "api"]) }
const accept = (): o.Accept => [{ tag: "AnyValue" }, { tag: "Matching", pattern: pick(pats) }, { tag: "Pinned", value: pick(["1", "a"]) }][r(3)] as o.Accept
const route = (): o.Route => ({ method: pick(methods), delivery: pick(["Buffered", "Streamed"] as const), path: Array.from({ length: 1 + r(3) }, piece),
  query: ["k", "v", "ownerVisibleOnly"].slice(r(3)).slice(0, r(3)).map((key) => ({ key, accepts: accept() })), limit: r(2) ? { tag: "AnySize" } : { tag: "AtMost", bytes: 1 + r(20) } })
const group = (): o.Group => ({ prefixes: Array.from({ length: r(3) }, () => Array.from({ length: r(3) }, () => pick(["a", "b", "api"]))), id: r(4) === 0 ? "" : pick(ids), routes: Array.from({ length: r(4) }, route) })
const request = (): o.Request => ({ method: pick(methods), delivery: pick(["Buffered", "Streamed"] as const),
  segments: Array.from({ length: 1 + r(3) }, () => { const text = pick(texts); return { text, fits: ids.filter((id) => new RegExp(`^(?:${id})$`, "u").test(text)) } }),
  query: Array.from({ length: r(3) }, () => { const value = pick(["1", "a", "9", "a b", ""]); return { key: pick(["k", "v", "ownerVisibleOnly", "z"]), value, fits: pats.filter((p) => new RegExp(`^(?:${p})$`, "u").test(value)) } }),
  flaws: r(5) === 0 ? [pick(["Backslash", "Fragment", "UnsafeCharacter", "PercentInPath", "MalformedEscape", "PathTooLong"] as const)] : [],
  body: [{ tag: "NoBody" }, { tag: "NotAnObject" }, { tag: "JsonObject", size: 2 + r(25) }][r(3)] as o.Request["body"] })
const flatGroup = (): o.Group[] => [{ prefixes: [[]], id: o.flatParam, routes: [route(), route()] }, ...(r(2) ? [{ prefixes: [["b"]], id: pick(pats), routes: [{ ...route(), path: [{ tag: "Literal", text: "b" }, { tag: "Param" }] }] }] : [])]
const matching = (routes: o.RouteList): o.Request => {
  const g = pick(routes); const t = pick(g.routes)
  const segText = (id: string) => pick(texts.filter((x) => new RegExp(`^(?:${id})$`, "u").test(x)).concat(id === "[0-9]+" ? ["9"] : []))
  const segments = t.path.map((p) => { const text = p.tag === "Literal" ? p.text : segText(g.id); return { text, fits: ids.concat(pats).filter((id, i, a) => a.indexOf(id) === i && new RegExp(`^(?:${id})$`, "u").test(text)) } })
  const query = t.query.map((q) => { const value = q.accepts.tag === "Pinned" ? q.accepts.value : q.accepts.tag === "Matching" ? (q.accepts.pattern === "[0-9]+" ? "9" : "a") : pick(["a", "a b", "+"]); return { key: q.key, value, fits: pats.filter((p) => new RegExp(`^(?:${p})$`, "u").test(value)) } })
  return { method: t.method, delivery: t.delivery, segments, query, flaws: r(8) === 0 ? [pick(["Backslash", "Fragment", "MalformedEscape"] as const)] : [], body: t.method === "Get" || t.method === "Delete" ? (r(6) ? { tag: "NoBody" } : { tag: "JsonObject", size: 2 }) : r(6) ? { tag: "JsonObject", size: 2 + r(25) } : { tag: "NotAnObject" } }
}
it("fuzz", () => {
  let loads = 0, mismatches = 0, admitted = 0, tooLarge = 0, n = 0
  for (let walk = 0; walk < 400; walk++) {
    driver.reset(); let st = o.initial
    for (let s = 0; s < 12; s++) {
      const served = o.served(st.table)
      const ev: any = r(4) === 0 ? { type: "load", routes: r(2) ? flatGroup() : Array.from({ length: r(3) }, group) } : { type: "admit", request: served.length && r(4) ? matching(served) : request() }
      const next = o.step(st, ev); st = next.state; if (ev.type === "load" && st.table.tag === "Loaded") loads++
      driver.dispatch("k", ev); n++
      const got = driver.observe("k"), out = driver.observeOutput!("k")
      if (ev.type === "admit") { if (next.out[0].tag === "Admitted") admitted++; if (next.out[0].tag === "TooLarge") tooLarge++ }
      if (JSON.stringify(got) !== JSON.stringify(st) || (ev.type === "admit" && JSON.stringify(out) !== JSON.stringify(next.out))) {
        if (mismatches++ < 3) console.log(JSON.stringify({ ev, want: st, got, out, wantOut: next.out }).slice(0, 3000))
      }
    }
  }
  console.log({ loads, n, mismatches, admitted, tooLarge })
  expect(mismatches).toBe(0)
})
