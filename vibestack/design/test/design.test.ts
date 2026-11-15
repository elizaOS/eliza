// Runs against packages/design-system: its tokens.json, design.md and installed Tailwind and ESLint.
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, onTestFinished, test } from "vitest"
import { designSystem } from "../eslint.ts"
import { check, syncDoc, themeCss, tokensCss } from "../generate.ts"
import { type Tokens, applyChanges, parseTokens } from "../tokens.ts"

const here = (file: string) => resolve(import.meta.dirname, file)
const dir = here("../../../packages/design-system")
// ESLint and its plugins belong to the project, so they resolve from there, not from the tool's directory.
const project = createRequire(`${dir}/`)
const load = (name: string) => import(pathToFileURL(project.resolve(name)).href)
const tokens = parseTokens(JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")))
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
  for (const file of ["tokens.json", "design.md"]) cpSync(join(dir, file), join(copy, file))
  execFileSync("node", [here("../cli.ts"), "build"], { cwd: copy })
  const [{ ESLint }, { default: tailwind }, { parser }] = await Promise.all(["eslint", "eslint-plugin-better-tailwindcss", "typescript-eslint"].map(load))
  const config = designSystem({ tailwind, tokens, entryPoint: join(copy, "generated/theme.css") })
  const eslint = new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: [{ files: ["**/*.tsx"], languageOptions: { parser } }, ...config] })
  const lint = async (name: string) => (await eslint.lintText(readFileSync(here(`fixtures/${name}`), "utf8"), { filePath: name }))[0]!.messages
  const [restricted, literal] = ["better-tailwindcss/no-restricted-classes", "design-system/no-literal-colors"]
  expect((await lint("bad.tsx")).map(({ line, ruleId }: { line: number; ruleId: string }) => [line, ruleId])).toEqual([
    [1, literal], [3, restricted], [4, restricted], [5, literal], [6, literal],
    ...Array.from({ length: 10 }, (_, i) => [8 + i, restricted]), [18, literal], [19, literal],
  ])
  expect(await lint("good.tsx")).toEqual([])
}, 60_000)
