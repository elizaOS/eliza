import { type Tokens, colorNames, contrastIssues } from "./tokens.ts"

const block = (selector: string, lines: string[], indent = "") =>
  `${indent}${selector} {\n${lines.map((line) => `${indent}  ${line}\n`).join("")}${indent}}\n`
const vars = (prefix: string, values: Record<string, string>) => Object.entries(values).map(([name, value]) => `--${prefix}${name}: ${value};`)
const scheme = (tokens: Tokens, theme: "light" | "dark") => [`color-scheme: ${theme};`, ...colorNames.map((name) => `--${name}: ${tokens.color[theme][name]};`)]
const fixed = (tokens: Tokens, duration: string) => [
  ...vars("font-", tokens.font), ...vars("shadow-", tokens.shadow),
  ...vars(duration, tokens.motion.duration), ...vars("ease-", tokens.motion.ease),
]

/** Plain custom properties, usable without Tailwind. */
export const tokensCss = (tokens: Tokens) =>
  block(":root", [...scheme(tokens, "light"), `--radius: ${tokens.radius};`, ...fixed(tokens, "duration-")]) +
  block(".dark", scheme(tokens, "dark")) +
  `@media (prefers-color-scheme: dark) {\n${block(":root:not(.light)", scheme(tokens, "dark"), "  ")}}\n`

/** The Tailwind v4 entry: utilities named after the tokens. */
export const themeCss = (tokens: Tokens) =>
  `@import "tailwindcss";\n@import "./tokens.css";\n@custom-variant dark (&:is(.dark *));\n` +
  block("@theme inline", [
    ...colorNames.map((name) => `--color-${name}: var(--${name});`),
    "--radius-sm: calc(var(--radius) - 4px);", "--radius-md: calc(var(--radius) - 2px);",
    "--radius-lg: var(--radius);", "--radius-xl: calc(var(--radius) + 4px);",
  ]) +
  block("@theme", [...fixed(tokens, "transition-duration-"), ...vars("breakpoint-", tokens.breakpoint)]) +
  `@layer base {\n${block("*", ["border-color: var(--border);"], "  ")}${
    block("body", ["background: var(--background);", "color: var(--foreground);", "font-family: var(--font-sans);"], "  ")}${
    block(":focus-visible", ["outline: 2px solid var(--ring);", "outline-offset: 2px;"], "  ")}}\n`

const [start, end] = ["<!-- tokens:start -->", "<!-- tokens:end -->"]
const table = (head: string[], rows: string[][]) =>
  [head, head.map(() => "---"), ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n")

/** `design.md` with its token table regenerated; prose outside the markers is kept. */
export function syncDoc(doc: string, tokens: Tokens): string {
  const [from, to] = [doc.indexOf(start), doc.indexOf(end)]
  if (from < 0 || to < from) throw new Error(`design.md needs ${start} and ${end}`)
  const { color, motion, ...rest } = tokens
  const flat = Object.entries({ ...rest, ...motion }).flatMap(([group, value]) =>
    typeof value === "string" ? [[`\`${group}\``, value]] : Object.entries(value).map(([name, each]) => [`\`${group}.${name}\``, each]))
  const tables = [
    table(["Color", "Light", "Dark"], colorNames.map((name) => [`\`${name}\``, color.light[name], color.dark[name]])),
    table(["Token", "Value"], flat),
  ]
  return `${doc.slice(0, from)}${start}\n${tables.join("\n\n")}\n${doc.slice(to)}`
}

/** What `check` reports beyond the token shapes: contrast below AA and a stale design.md. */
export const check = (tokens: Tokens, doc: string) => [
  ...contrastIssues(tokens),
  ...(syncDoc(doc, tokens) === doc ? [] : ["design.md: the token table is stale; run the design CLI's `build`"]),
]
