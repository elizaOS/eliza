// Runs against packages/design-system: its tokens.json, design.md and installed Tailwind and ESLint.
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, onTestFinished, test } from "vitest"
import { designSystem } from "../eslint.ts"
import { check, syncDoc, themeCss, tokensCss } from "../generate.ts"
import { type Tokens, applyChanges, palette, parseTokens } from "../tokens.ts"

const here = (file: string) => resolve(import.meta.dirname, file)
const dir = here("../../../packages/design-system")
// ESLint and its plugins belong to the project, so they resolve from there, not from the tool's directory.
const project = createRequire(`${dir}/`)
const load = (name: string) => import(pathToFileURL(project.resolve(name)).href)
const tokens = parseTokens(JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")))
/** The project's tokens with a sized type scale, weights, line heights, letter spacing, layers and a focus ring; `6` and `10` are Tailwind-like names the project chose. */
const scaled = parseTokens({
  ...tokens,
  text: { body: "1rem", display: { size: "3rem", leading: "1", tracking: "-0.04em" }, caption: { size: "0.75rem", leading: "1rem" } },
  weight: { regular: "400", strong: "650" },
  leading: { snug: "1.3", 6: "1.6" },
  tracking: { wide: "0.08em" },
  z: { overlay: "40", 10: "10" },
  focus: { width: "3px", offset: "-2px" },
})
const primary = { path: "color.light.primary", value: "oklch(0.45 0.2 277)", reason: "deeper accent" }
const changedLines = (before: string, after: string) => {
  const old = before.split("\n")
  return after.split("\n").filter((line, index) => line !== old[index])
}

test("generated CSS is deterministic and a token change touches only that token's lines", () => {
  const copy = JSON.parse(JSON.stringify(tokens)) as Tokens
  expect([tokensCss(copy), themeCss(copy)]).toEqual([tokensCss(tokens), themeCss(tokens)])
  const next = applyChanges(tokens, [primary]).tokens
  expect(changedLines(tokensCss(tokens), tokensCss(next))).toEqual(Array(2).fill("  --primary: oklch(0.45 0.2 277);"))
  expect(themeCss(next)).toBe(themeCss(tokens))
  const dark = applyChanges(tokens, [{ ...primary, path: "color.dark.primary", value: "oklch(0.75 0.15 282)" }]).tokens
  expect(changedLines(tokensCss(tokens), tokensCss(dark))).toEqual(["  --primary: oklch(0.75 0.15 282);", "    --primary: oklch(0.75 0.15 282);"])
})

test("apply accepts a valid change and rejects an unknown path, an invalid color and broken contrast", () => {
  const { tokens: next, diff } = applyChanges(tokens, [primary])
  expect(next.color.light.primary).toBe(primary.value)
  expect(tokens.color.light.primary).not.toBe(primary.value)
  expect(diff).toBe(`# deeper accent\n- color.light.primary: ${tokens.color.light.primary}\n+ color.light.primary: ${primary.value}`)
  expect(() => applyChanges(tokens, [{ ...primary, path: "color.light.brand" }])).toThrow("unknown token path: color.light.brand")
  expect(() => applyChanges(tokens, [{ ...primary, path: "constructor.name" }])).toThrow("unknown token path")
  expect(() => applyChanges(tokens, [{ ...primary, value: "#4f46e5" }])).toThrow(/expected oklch/)
  expect(() => applyChanges(tokens, [{ ...primary, value: "oklch(0.9 0.05 277)" }])).toThrow(/color\.light\.primary-foreground on primary: contrast .* is below 4\.5/)
  // A field's outline is seen, not read: 3:1 against the page (WCAG 1.4.11).
  expect(() => applyChanges(tokens, [{ path: "color.dark.input", value: tokens.color.dark.background, reason: "invisible field" }])).toThrow(/color\.dark\.input on background: contrast 1\.00 is below 3/)
  expect(() => applyChanges(tokens, [{ path: "color.light.ring", value: tokens.color.light.card, reason: "invisible focus" }])).toThrow(/color\.light\.ring on card: contrast 1\.00 is below 3/)
  expect(() => applyChanges(tokens, [{ path: primary.path, value: primary.value }])).toThrow(/reason/)
  const { radius: _, ...rest } = tokens
  expect(() => parseTokens({ ...rest, spacing: "1rem" })).toThrow("unknown token path: spacing\nradius: missing")
  // A palette color is named in light; dark may override it but never introduce one.
  expect(() => parseTokens({ ...tokens, color: { ...tokens.color, dark: { ...tokens.color.dark, brand: "oklch(0.5 0.1 200)" } } })).toThrow("color.dark.brand: no light value")
  expect(() => parseTokens({ ...tokens, text: { body: "20" } })).toThrow("text.body: expected a length in rem or px")
  expect(() => parseTokens({ ...tokens, keyframes: { blink: "opacity:0" } })).toThrow("keyframes.blink: expected keyframe stops")
  expect(() => parseTokens({ ...tokens, text: { ...tokens.text, primary: "1rem" } })).toThrow("text.primary: also a color")
})

test("a palette color, radius, size, blur and gradient each become a utility; a palette color without a dark value keeps its light one", () => {
  const next = parseTokens({ ...tokens, color: { light: { ...tokens.color.light, brand: "oklch(0.5 0.1 200)" }, dark: tokens.color.dark }, rounded: { pill: "999px" }, text: { hero: "3rem" }, blur: { frost: "20px" }, keyframes: { blink: "50%{opacity:0}" }, animate: { blink: "blink 1s step-end infinite" }, gradient: { sky: "linear-gradient(var(--brand), var(--primary))" } })
  const [css, theme] = [tokensCss(next), themeCss(next)]
  // Set in :root and .light; .dark and a dark system inherit it.
  expect(css.match(/--brand: [^;]+;/g)).toEqual(["--brand: oklch(0.5 0.1 200);", "--brand: oklch(0.5 0.1 200);"])
  for (const line of ["--color-brand: var(--brand);", "--radius-pill: 999px;", "--text-hero: 3rem;", "--blur-frost: 20px;", "--animate-blink: blink 1s step-end infinite;", "@keyframes blink { 50%{opacity:0} }", "@utility bg-gradient-sky {"]) expect(theme).toContain(line)
  expect(css).toContain("--gradient-sky: linear-gradient(var(--brand), var(--primary));")
})

test("a font size may carry its line height and letter spacing; weights, line heights, letter spacing, layers and the focus ring are scales", () => {
  for (const [path, value, problem] of [
    ["text.caption", { leading: "1rem" }, "text.caption.size: missing"],
    ["text.caption", { size: "12", leading: "1rem" }, "text.caption.size: expected a length in rem or px"],
    ["text.caption", { size: "1rem", weight: "500" }, "unknown token path: text.caption.weight"],
    ["text.display", { size: "3rem", tracking: "-1px" }, "text.display.tracking: expected a letter spacing in em"],
    ["weight.strong", "1001", "weight.strong: expected a font weight"],
    ["leading.snug", "snug", "leading.snug: expected a line height"],
    ["tracking.wide", "0.08", "tracking.wide: expected a letter spacing in em"],
    ["z.overlay", "4.5", "z.overlay: expected an integer z-index"],
    ["focus.width", "-2px", "focus.width: expected a length"],
    ["focus.color", "red", "unknown token path: focus.color"],
    // An empty object where a value belongs is refused, not skipped.
    ["text.caption", { size: {} }, "text.caption.size: expected a length in rem or px, got {}"],
    ["text.display", { size: "3rem", leading: {}, tracking: {} }, "text.display.leading: expected a line height: a number, or a length in rem or px, got {}\ntext.display.tracking: expected a letter spacing in em, got {}"],
    ["focus.width", {}, "focus.width: expected a length in rem or px, got {}"],
    ["focus.offset", {}, "focus.offset: expected a length in rem or px, got {}"],
    ["weight.a", {}, "weight.a: expected a font weight from 1 to 1000, got {}"],
    ["shadow.a", {}, "shadow.a: expected a value, got {}"],
    ["rounded.a", {}, "rounded.a: expected a length in rem or px, got {}"],
    // So is one nested where no group is, whose leaves are only empty objects.
    ["shadow.a", { b: {} }, "unknown token path: shadow.a.b"],
    ["weight.a", { b: {} }, "unknown token path: weight.a.b"],
    ["text.body", { size: "1rem", x: {} }, "unknown token path: text.body.x"],
    ["focus.x", {}, "unknown token path: focus.x"],
  ] as const) {
    const [group, name] = path.split(".") as [keyof Tokens, string]
    expect(() => parseTokens({ ...scaled, [group]: { ...scaled[group] as object, [name]: value } }), path).toThrow(problem)
  }
  // An empty group is no tokens, not a wrong one.
  expect(parseTokens({ ...tokens, shadow: {}, weight: {}, focus: {} }).weight).toEqual({})
  expect(() => parseTokens({ ...tokens, bogus: {} })).toThrow("unknown token path: bogus")
  // Only the focus ring's own parts are given; the other keeps 2px.
  expect(themeCss(parseTokens({ ...tokens, focus: { width: "3px" } }))).toContain("outline: 3px solid var(--ring);\n    outline-offset: 2px;")
})

test("Tailwind compiles each scale into its utility, and design.md lists each part", async () => {
  const { compile } = await load("tailwindcss")
  const compiler = await compile(themeCss(scaled), {
    base: dir,
    loadStylesheet: async (id: string) =>
      ({ path: id, base: dir, content: id === "tailwindcss" ? readFileSync(project.resolve("tailwindcss/index.css"), "utf8") : tokensCss(scaled) }),
  })
  const css: string = compiler.build(["text-body", "text-display", "font-strong", "leading-snug", "leading-6", "tracking-wide", "z-overlay", "z-10", "outline-focus", "outline-offset-focus"])
  const rule = (name: string) => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1]?.replace(/\s+/g, " ").trim()
  expect(Object.fromEntries(["text-body", "text-display", "font-strong", "leading-6", "tracking-wide", "z-overlay", "z-10", "outline-focus", "outline-offset-focus"].map((name) => [name, rule(name)]))).toEqual({
    "text-body": "font-size: var(--text-body);",
    "text-display": "font-size: var(--text-display); line-height: var(--tw-leading, var(--text-display--line-height)); letter-spacing: var(--tw-tracking, var(--text-display--letter-spacing));",
    "font-strong": "--tw-font-weight: var(--font-weight-strong); font-weight: var(--font-weight-strong);",
    "leading-6": "--tw-leading: var(--leading-6); line-height: var(--leading-6);",
    "tracking-wide": "--tw-tracking: var(--tracking-wide); letter-spacing: var(--tracking-wide);",
    "z-overlay": "z-index: var(--z-index-overlay);",
    "z-10": "z-index: var(--z-index-10);",
    "outline-focus": "outline-style: var(--tw-outline-style); outline-width: var(--outline-width-focus);",
    "outline-offset-focus": "outline-offset: var(--outline-offset-focus);",
  })
  for (const declaration of ["--text-display: 3rem;", "--text-display--line-height: 1;", "--text-display--letter-spacing: -0.04em;", "--font-weight-strong: 650;",
    "--leading-6: 1.6;", "--z-index-overlay: 40;", "--outline-width-focus: 3px;", "outline: 3px solid var(--ring);", "outline-offset: -2px;"])
    expect(css).toContain(declaration)
  const doc = syncDoc(readFileSync(join(dir, "design.md"), "utf8"), scaled)
  expect(check(scaled, doc)).toEqual([])
  expect(doc).toContain("| `text.body` | 1rem |\n| `text.display.size` | 3rem |\n| `text.display.leading` | 1 |\n| `text.display.tracking` | -0.04em |\n")
  expect(doc).toContain("| `z.10` | 10 |\n| `z.overlay` | 40 |\n| `focus.width` | 3px |\n| `focus.offset` | -2px |\n")
})

test("a token name Tailwind's utilities already give another meaning is refused, as is one name in two groups that share a utility", async () => {
  const add = (group: string, name: string) => {
    if (group === "color") return { ...tokens, color: { ...tokens.color, light: { ...tokens.color.light, [name]: "oklch(0.5 0.1 200)" } } }
    const value = { text: "1rem", shadow: "0 1px 2px oklch(0 0 0)", font: "Inter", weight: "500", gradient: "none" }[group]
    return { ...tokens, [group]: { ...(tokens as unknown as Record<string, object>)[group], [name]: value } }
  }
  for (const [group, name, problem] of [
    ["color", "sm", "color.light.sm: Tailwind's bg-, text-, border-, outline-, ring-, shadow-, divide- or decoration- already takes sm"],
    ["color", "lg", "color.light.lg: Tailwind's"], ["color", "2", "unknown token path: color.light.2"],
    ["color", "linear-to-r", "color.light.linear-to-r: Tailwind's"], ["color", "x", "color.light.x: Tailwind's"], ["color", "radius", "color.light.radius: Tailwind's"], ["color", "transparent", "color.light.transparent: Tailwind's"],
    ["text", "center", "text.center: Tailwind's text- already takes center"], ["text", "white", "text.white: Tailwind's"],
    ["font", "bold", "font.bold: Tailwind's font- already takes bold"], ["weight", "mono", "weight.mono: Tailwind's font- already takes mono"],
    ["weight", "sans", "weight.sans: also a font, so font-sans would set the font; rename one"],
    ["shadow", "white", "shadow.white: Tailwind's shadow- already takes white"], ["gradient", "to-r", "gradient.to-r: Tailwind's bg-gradient- already takes to-r"],
  ] as const) expect(() => parseTokens(add(group, name)), `${group}.${name}`).toThrow(problem)
  expect(() => parseTokens({ ...add("color", "focus"), focus: { width: "3px" } })).toThrow("color.light.focus: also the focus ring width")
  expect(() => parseTokens({ ...add("color", "glow"), shadow: { glow: "0 0 8px oklch(0 0 0)" } })).toThrow("shadow.glow: also a color, so shadow-glow would set the color; rename one")
  expect(parseTokens({ ...add("color", "brand"), text: { "2xl": "1.5rem" }, z: { 50: "50" } }).color.light.brand).toBeDefined()
  // Every value Tailwind's own utilities give these groups' classes, outside the group's namespace, is refused.
  const tailwind = project.resolve("tailwindcss/index.css")
  const { __unstable__loadDesignSystem } = await load("tailwindcss")
  const system = await __unstable__loadDesignSystem(`@import "tailwindcss";`, {
    base: dirname(tailwind), loadStylesheet: async () => ({ path: tailwind, base: dirname(tailwind), content: readFileSync(tailwind, "utf8") }),
  })
  const classes: string[] = system.getClassList().map(([name]: [string]) => name)
  const own = (namespace: string) => [...system.theme.namespace(namespace).keys()]
  // The one palette list tokens.ts and eslint.ts share is Tailwind's.
  expect(palette.split("|").sort()).toEqual([...new Set(own("--color").flatMap((name: string) => /^([a-z]+)-\d+$/.exec(name)?.[1] ?? []))].sort())
  for (const [group, roots, namespace] of [
    ["color", ["bg", "text", "border", "outline", "ring", "ring-offset", "shadow", "inset-shadow", "inset-ring", "drop-shadow", "text-shadow", "fill", "stroke", "decoration", "divide", "accent", "caret", "placeholder", "from", "via", "to"], own("--color")],
    ["text", ["text"], own("--text")], ["shadow", ["shadow"], own("--shadow")], ["font", ["font"], own("--font")], ["weight", ["font"], own("--font-weight")],
  ] as const) {
    const values = classes.flatMap((name) => roots.flatMap((root) => name.startsWith(`${root}-`) ? [name.slice(root.length + 1)] : []))
    const taken = [...new Set(values)].filter((value) => /^[a-z]/.test(value) && !(namespace as readonly string[]).includes(value))
    expect(taken.length, group).toBeGreaterThan(0)
    for (const value of taken) expect(() => parseTokens(add(group, value)), `${group}.${value}`).toThrow()
  }
}, 60_000)

test("check passes on the project's tokens and design.md, and detects a stale design.md", () => {
  const doc = readFileSync(join(dir, "design.md"), "utf8")
  expect(check(tokens, doc)).toEqual([])
  const next = applyChanges(tokens, [primary]).tokens
  expect(check(next, doc)).toEqual([expect.stringContaining("design.md: the token table is stale")])
  expect(check(next, syncDoc(doc, next))).toEqual([])
})

test("the ESLint config flags values that bypass the tokens and accepts token classes", async () => {
  // The CLI builds a copy under the project's .cache/, so this never races the project's own build; Tailwind still resolves from the project.
  mkdirSync(join(dir, ".cache"), { recursive: true })
  const copy = mkdtempSync(join(dir, ".cache/design-test-"))
  onTestFinished(() => rmSync(copy, { recursive: true, force: true }))
  const [{ ESLint }, { default: tailwind }, { parser }] = await Promise.all(["eslint", "eslint-plugin-better-tailwindcss", "typescript-eslint"].map(load))
  const linter = (name: string, json: string) => {
    mkdirSync(join(copy, name))
    writeFileSync(join(copy, name, "tokens.json"), json)
    cpSync(join(dir, "design.md"), join(copy, name, "design.md"))
    execFileSync("node", [here("../cli.ts"), "build"], { cwd: join(copy, name) })
    const config = designSystem({ tailwind, tokens: parseTokens(JSON.parse(json)), entryPoint: join(copy, name, "generated/theme.css") })
    return new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: [{ files: ["**/*.tsx"], languageOptions: { parser } }, ...config] })
  }
  // The project's own tokens.json, then one that declares each scale, and one whose scales are all empty.
  const [eslint, withScales, empty] = [
    linter("project", readFileSync(join(dir, "tokens.json"), "utf8")), linter("scaled", JSON.stringify(scaled)),
    linter("empty", JSON.stringify({ ...tokens, text: {}, weight: {}, leading: {}, tracking: {}, z: {} })),
  ]
  const lint = async (name: string, using = eslint) => (await using.lintText(readFileSync(here(`fixtures/${name}`), "utf8"), { filePath: name }))[0]!.messages
  const [restricted, literal] = ["better-tailwindcss/no-restricted-classes", "design-system/no-literal-colors"]
  expect((await lint("bad.tsx")).map(({ line, ruleId }: { line: number; ruleId: string }) => [line, ruleId])).toEqual([
    [1, literal], [3, restricted], [4, restricted], [5, literal], [6, literal],
    ...Array.from({ length: 10 }, (_, i) => [8 + i, restricted]), [18, literal], [19, literal],
  ])
  expect(await lint("good.tsx")).toEqual([])
  expect(await lint("good.tsx", empty)).toEqual([])
  expect((await lint("scales.tsx", withScales)).map(({ line, ruleId }: { line: number; ruleId: string }) => [line, ruleId]))
    .toEqual(Array.from({ length: 12 }, (_, i) => [3 + i, restricted]))
}, 60_000)
