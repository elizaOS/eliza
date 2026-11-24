import { type Tokens, contrastIssues, leaves } from "./tokens.ts"

const block = (selector: string, lines: string[], indent = "") =>
  `${indent}${selector} {\n${lines.map((line) => `${indent}  ${line}\n`).join("")}${indent}}\n`
const vars = (prefix: string, values: Record<string, string>) => Object.entries(values).map(([name, value]) => `--${prefix}${name}: ${value};`)
// Every color the light theme names, in its order; a color the dark theme leaves out keeps its light value.
const names = (tokens: Tokens) => Object.keys(tokens.color.light)
const scheme = (tokens: Tokens, theme: "light" | "dark") =>
  [`color-scheme: ${theme};`, ...names(tokens).filter((name) => name in tokens.color[theme]).map((name) => `--${name}: ${tokens.color[theme][name]};`)]
/** A font size, and the line height and letter spacing Tailwind sets with it where the size gives them. */
const sizes = (tokens: Tokens) => Object.entries(tokens.text).flatMap(([name, value]) => typeof value === "string" ? [`--text-${name}: ${value};`] : [
  `--text-${name}: ${value.size};`,
  ...value.leading === undefined ? [] : [`--text-${name}--line-height: ${value.leading};`],
  ...value.tracking === undefined ? [] : [`--text-${name}--letter-spacing: ${value.tracking};`],
])
const focus = (tokens: Tokens) => ({ width: "2px", offset: "2px", ...tokens.focus })
const fixed = (tokens: Tokens, duration: string) => [
  ...vars("font-", tokens.font), ...vars("shadow-", tokens.shadow),
  ...vars(duration, tokens.motion.duration), ...vars("ease-", tokens.motion.ease),
]

/** Plain custom properties, usable without Tailwind. */
export const tokensCss = (tokens: Tokens) =>
  block(":root", [...scheme(tokens, "light"), `--radius: ${tokens.radius};`, ...fixed(tokens, "duration-"), ...vars("gradient-", tokens.gradient)]) +
  block(".light", scheme(tokens, "light")) +
  block(".dark", scheme(tokens, "dark")) +
  `@media (prefers-color-scheme: dark) {\n${block(":root:not(.light)", scheme(tokens, "dark"), "  ")}}\n`

/** The Tailwind v4 entry: utilities named after the tokens. */
export const themeCss = (tokens: Tokens) =>
  `@import "tailwindcss";\n@import "./tokens.css";\n` +
  // As tokens.css chooses the dark values: under `.dark`, or on a dark system outside `.light`.
  `@custom-variant dark {\n  &:is(.dark, .dark *) {\n    @slot;\n  }\n  @media (prefers-color-scheme: dark) {\n    &:not(:is(.light, .light *)) {\n      @slot;\n    }\n  }\n}\n` +
  block("@theme inline", [
    ...names(tokens).map((name) => `--color-${name}: var(--${name});`),
    ...vars("drop-shadow-", tokens.dropShadow),
    "--radius-sm: calc(var(--radius) - 4px);", "--radius-md: calc(var(--radius) - 2px);",
    "--radius-lg: var(--radius);", "--radius-xl: calc(var(--radius) + 4px);",
  ]) +
  block("@theme", [
    ...fixed(tokens, "transition-duration-"), ...vars("breakpoint-", tokens.breakpoint),
    ...vars("radius-", tokens.rounded), ...sizes(tokens), ...vars("blur-", tokens.blur), ...vars("animate-", tokens.animate),
    ...vars("font-weight-", tokens.weight), ...vars("leading-", tokens.leading), ...vars("tracking-", tokens.tracking), ...vars("z-index-", tokens.z),
    ...tokens.focus?.width === undefined ? [] : [`--outline-width-focus: ${tokens.focus.width};`],
    ...tokens.focus?.offset === undefined ? [] : [`--outline-offset-focus: ${tokens.focus.offset};`],
    ...Object.entries(tokens.keyframes).map(([name, stops]) => `@keyframes ${name} { ${stops} }`),
  ]) +
  Object.keys(tokens.gradient).map((name) => block(`@utility bg-gradient-${name}`, [`background-image: var(--gradient-${name});`])).join("") +
  `@layer base {\n${block("*", ["border-color: var(--border);"], "  ")}${
    block("body", ["background: var(--background);", "color: var(--foreground);", "font-family: var(--font-sans);"], "  ")}${
    block(":focus-visible", [`outline: ${focus(tokens).width} solid var(--ring);`, `outline-offset: ${focus(tokens).offset};`], "  ")}}\n`

const [start, end] = ["<!-- tokens:start -->", "<!-- tokens:end -->"]
const table = (head: string[], rows: string[][]) =>
  [head, head.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n")

/** `design.md` with its token table regenerated; prose outside the markers is kept. */
export function syncDoc(doc: string, tokens: Tokens): string {
  const [from, to] = [doc.indexOf(start), doc.indexOf(end)]
  if (from < 0 || to < from) throw new Error(`design.md needs ${start} and ${end}`)
  const { color, motion, ...rest } = tokens
  const flat = leaves({ ...rest, ...motion }).map(([path, value]) => [`\`${path}\``, String(value)])
  const tables = [
    table(["Color", "Light", "Dark"], Object.keys(color.light).map((name) => [`\`${name}\``, color.light[name]!, color.dark[name] ?? "—"])),
    table(["Token", "Value"], flat),
  ]
  return `${doc.slice(0, from)}${start}\n${tables.join("\n\n")}\n${doc.slice(to)}`
}

/** What `check` reports beyond the token shapes: contrast below AA and a stale design.md. */
export const check = (tokens: Tokens, doc: string) => [
  ...contrastIssues(tokens),
  ...(syncDoc(doc, tokens) === doc ? [] : ["design.md: the token table is stale; run the design CLI's `build`"]),
]
