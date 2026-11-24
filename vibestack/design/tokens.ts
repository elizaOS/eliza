export const colorNames = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
  "accent", "accent-foreground", "destructive", "destructive-foreground", "border", "input", "ring", "ok", "warn", "info",
] as const
type ColorName = (typeof colorNames)[number]
type Named = Record<string, string>
/**
 * Beside the required colors, `color.light` may name a project palette (`lilac`, `glass` …); `color.dark` may
 * give any of them a dark value, and one it does not give keeps its light value.
 */
export interface Tokens {
  color: { light: Record<ColorName, string> & Named; dark: Record<ColorName, string> & Named }
  radius: string
  font: { sans: string; mono: string } & Named
  shadow: Named
  /** Filter shadows that follow a shape's outline, such as an icon's or a speech tail's: `drop-shadow-<name>`. */
  dropShadow: Named
  motion: { duration: Named; ease: Named }
  breakpoint: Named
  /** Named radii beside the derived `rounded-sm` … `rounded-xl`: `rounded-<name>`. */
  rounded: Named
  /** Background images, usually gradients over palette colors: `bg-gradient-<name>`. */
  gradient: Named
  /** Font sizes: `text-<name>`; the object form also sets its line height and letter spacing. */
  text: Record<string, string | TextSize>
  /** Font weights: `font-<name>`, beside the families of `font`. */
  weight: Named
  /** Line heights: `leading-<name>`. */
  leading: Named
  /** Letter spacing: `tracking-<name>`. */
  tracking: Named
  /** Stacking layers: `z-<name>`. */
  z: Named
  /**
   * The keyboard focus ring of `:focus-visible`, 2px wide and 2px off the element unless given. `outline-focus` exists
   * only when `width` is declared, and `outline-offset-focus` only when `offset` is.
   */
  focus?: { width?: string; offset?: string }
  /** Blur radii: `blur-<name>`, `backdrop-blur-<name>`. */
  blur: Named
  /** Keyframe bodies by name, such as `"50%{opacity:0}"`, for `animate` to run. */
  keyframes: Named
  /** Animations: `animate-<name>`, such as `"blink 1s step-end infinite"`. */
  animate: Named
}
/** A font size with the line height and letter spacing that go with it, as Tailwind's `--text-<name>--line-height`. */
export interface TextSize { size: string; leading?: string; tracking?: string }
/** The only way a proposed change enters: a token's dotted path, its new value and why. */
interface TokenChange { path: string; value: string; reason: string }

const text: [RegExp, string] = [/\S/, "a value"]
const length: [RegExp, string] = [/^\d*\.?\d+(?:rem|px)$/, "a length in rem or px"]
const leading: [RegExp, string] = [/^\d*\.?\d+(?:rem|px)?$/, "a line height: a number, or a length in rem or px"]
const tracking: [RegExp, string] = [/^(?:0|-?\d*\.?\d+em)$/, "a letter spacing in em"]
/** What each token path holds; `*` is a name the project chooses, `#` one that may also start with a digit (`2xl`, `10`). */
const kinds: [path: string, [RegExp, string]][] = [
  ["color.(?:light|dark).*", [/^oklch\((?:0|1|0?\.\d+) (?:0|0?\.\d+) \d{1,3}(?:\.\d+)?\)$/, "oklch(L C H), opaque, with L from 0 to 1"]],
  ["radius", length], ["font.*", text], ["shadow.*", text], ["dropShadow.*", text],
  ["motion.duration.*", [/^\d+ms$/, "a duration in ms"]], ["motion.ease.*", text], ["breakpoint.*", length],
  ["rounded.*", length], ["gradient.*", text], ["text.#", length], ["blur.*", length],
  ["text.#.size", length], ["text.#.leading", leading], ["text.#.tracking", tracking],
  ["weight.#", [/^(?:[1-9]\d{0,2}|1000)$/, "a font weight from 1 to 1000"]], ["leading.#", leading], ["tracking.#", tracking],
  ["z.#", [/^-?(?:0|[1-9]\d{0,8})$/, "an integer z-index"]], ["focus.width", length], ["focus.offset", [/^-?\d*\.?\d+(?:rem|px)$/, "a length in rem or px"]],
  ["keyframes.*", [/^(?:[^{}]*\{[^{}]*\})+$/, "keyframe stops, such as 50%{opacity:0}"]], ["animate.*", text],
]
const tokenPath = (pattern: string) => new RegExp(`^${pattern.replaceAll(".", "\\.").replace("*", "[a-z][a-z0-9-]*").replace("#", "[a-z0-9][a-z0-9-]*")}$`)
const tokenKinds = kinds.map(([pattern, kind]) => ({ path: tokenPath(pattern), kind }))
const kindOf = (path: string) => tokenKinds.find((entry) => entry.path.test(path))?.kind
const tokenGroups = [...new Set(kinds.flatMap(([pattern]) => pattern.split(".").slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join("."))))].map(tokenPath)
const required = ["light", "dark"].flatMap((theme) => colorNames.map((name) => `color.${theme}.${name}`)).concat("radius", "font.sans", "font.mono")

/** Tailwind v4's default palette (tailwindcss 4.3 theme.css): the colors of `bg-red-500` and the like. */
export const palette = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe"
/**
 * Names Tailwind v4's own utilities already give a meaning outside the group's namespace, so a token of that name would
 * make a class ambiguous: a color `sm` would be `text-sm` and `shadow-sm` too, a font weight `mono` would be `font-mono`.
 * A word followed by `(?:-.*)?` reserves the family it heads, such as `bg-linear-to-r` and `border-x-2`. A color also
 * may not take the name of another token's custom property in tokens.css (`--radius`, `--font-sans`).
 */
const taken: [group: string, utilities: string, names: RegExp][] = [
  ["color.light", "bg-, text-, border-, outline-, ring-, shadow-, divide- or decoration-", new RegExp(`^(?:auto|balance|base|center|collapse|contain|cover|current|dashed|dotted|double|ellipsis|end|fixed|from-font|hidden|inherit|initial|inner|inset|justify|left|lg|local|md|no-repeat|none|nowrap|pretty|right|scroll|separate|sm|solid|start|transparent|wavy|wrap|xl|xs|(?:b|be|bs|e|l|r|s|t|x|y|blend|bottom|clip|conic|duration|ease|font|gradient|linear|offset|origin|radial|radius|repeat|shadow|spacing|top)(?:-.*)?)$`)],
  ["text", "text-", new RegExp(`^(?:balance|center|clip|ellipsis|end|justify|left|nowrap|pretty|right|start|wrap|white|black|current|inherit|transparent|(?:${palette})-\\d+|shadow(?:-.*)?)$`)],
  ["shadow", "shadow-", new RegExp(`^(?:initial|none|white|black|current|inherit|transparent|(?:${palette})-\\d+)$`)],
  ["font", "font-", /^(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|stretch(?:-.*)?)$/],
  ["weight", "font-", /^(?:sans|serif|mono|stretch(?:-.*)?)$/],
  ["gradient", "bg-gradient-", /^to(?:-.*)?$/],
]
/** Groups whose utilities share a prefix, so one name in both would be ambiguous: `text-<size>` and `text-<color>`. */
const shared: [group: string, other: string, utility: string, sets: string][] = [
  ["text", "color.light", "text", "a color"], ["shadow", "color.light", "shadow", "a color"], ["weight", "font", "font", "a font"],
]
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
export const leaves = (value: unknown, path = ""): [string, unknown][] =>
  isRecord(value) ? Object.entries(value).flatMap(([key, each]) => leaves(each, path ? `${path}.${key}` : key)) : [[path, value]]

/** `input` as tokens: every leaf a known path holding a valid value, nothing missing. Throws with every problem. */
export function parseTokens(input: unknown): Tokens {
  const found = leaves(input)
  // An empty object where a value belongs has no leaves, so it would pass unseen; it is a value, and not a valid one.
  const holes = (value: unknown, path: string): [string, unknown][] => !isRecord(value) ? [] : Object.keys(value).length
    ? Object.entries(value).flatMap(([key, each]) => holes(each, path ? `${path}.${key}` : key)) : [[path, value]]
  const group = (path: string) => {
    const value = path.split(".").reduce<unknown>((at, key) => isRecord(at) ? at[key] : undefined, input)
    return isRecord(value) ? value : {}
  }
  const names = (path: string) => Object.keys(group(path))
  // An empty object where a value belongs has no leaves, so it would pass unseen; it is a value, and not a valid one.
  const problems = found.concat(holes(input, "").filter(([path]) => path && !(tokenGroups.some((pattern) => pattern.test(path)) && !kindOf(path)))).flatMap(([path, value]) => {
    const kind = kindOf(path)
    if (!kind) return [`unknown token path: ${path}`]
    return typeof value === "string" && kind[0].test(value) ? [] : [`${path}: expected ${kind[1]}, got ${JSON.stringify(value)}`]
  }).concat(required.filter((path) => !found.some(([at]) => at === path)).map((path) => `${path}: missing`))
    // A dark value overrides a light one, so a dark-only color would have nothing to stand for in light.
    .concat(found.filter(([path]) => path.startsWith("color.dark.") && !found.some(([at]) => at === path.replace("dark", "light"))).map(([path]) => `${path}: no light value`))
    // A font size given as an object still needs its size.
    .concat(Object.entries(group("text")).filter(([, size]) => isRecord(size) && !("size" in size)).map(([name]) => `text.${name}.size: missing`))
    // `text-<name>` is a color when both exist, so the size would silently never apply; so with a shadow or a weight.
    .concat(shared.flatMap(([one, other, utility, sets]) => names(one).filter((name) => names(other).includes(name)).map((name) => `${one}.${name}: also ${sets}, so ${utility}-${name} would set the ${sets.slice(2)}; rename one`)))
    .concat(taken.flatMap(([at, utilities, reserved]) => names(at).filter((name) => reserved.test(name))
      .map((name) => `${at}.${name}: Tailwind's ${utilities} already takes ${name}, so the class would be ambiguous; rename it`)))
    .concat(names("color.light").includes("focus") && group("focus").width !== undefined ? ["color.light.focus: also the focus ring width, so outline-focus would be ambiguous; rename one"] : [])
  if (problems.length) throw new Error(problems.join("\n"))
  const given = structuredClone(input) as Partial<Tokens>
  return { ...given, shadow: given.shadow ?? {}, dropShadow: given.dropShadow ?? {}, motion: { duration: {}, ease: {}, ...given.motion }, breakpoint: given.breakpoint ?? {}, rounded: given.rounded ?? {}, gradient: given.gradient ?? {}, text: given.text ?? {}, weight: given.weight ?? {}, leading: given.leading ?? {}, tracking: given.tracking ?? {}, z: given.z ?? {}, blur: given.blur ?? {}, keyframes: given.keyframes ?? {}, animate: given.animate ?? {} } as Tokens
}

const linear = (color: string) => {
  const [L, C, H] = color.slice(6, -1).split(" ").map(Number) as [number, number, number]
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel))) as [number, number, number]
}
const luminance = (color: string) => {
  const [r, g, b] = linear(color)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG 2 contrast ratio of two oklch colors. */
export const contrast = (one: string, other: string) => {
  const [dark, light] = [luminance(one), luminance(other)].sort((x, y) => x - y) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** Text color on surface: each `x-foreground` on `x`, every color used as text on the page and on a card, and `muted-foreground` on each quiet fill. */
const contrastPairs: [ColorName, ColorName][] = [
  ["foreground", "background"], ["foreground", "muted"],
  ...(["popover", "muted", "secondary", "accent"] as const).map((surface): [ColorName, ColorName] => ["muted-foreground", surface]),
  ...colorNames.filter((name) => name.endsWith("-foreground")).map((name): [ColorName, ColorName] => [name, name.slice(0, -11) as ColorName]),
  ...(["muted-foreground", "primary", "destructive", "ok", "warn", "info"] as const).flatMap((name): [ColorName, ColorName][] => [[name, "background"], [name, "card"]]),
]
/** WCAG 1.4.11: the edge of a control and the focus ring, on what they sit on. */
const boundaryPairs = (["input", "ring"] as const).flatMap((name): [ColorName, ColorName][] => [[name, "background"], [name, "card"]])

/** Every pair below WCAG AA, in both themes: 4.5:1 for text, 3:1 for a boundary. */
export const contrastIssues = (tokens: Tokens) =>
  (["light", "dark"] as const).flatMap((theme) =>
    ([[contrastPairs, 4.5], [boundaryPairs, 3]] as const).flatMap(([pairs, least]) =>
      pairs.flatMap(([color, surface]) => {
        const ratio = contrast(tokens.color[theme][color], tokens.color[theme][surface])
        return ratio < least ? [`color.${theme}.${color} on ${surface}: contrast ${ratio.toFixed(2)} is below ${least}`] : []
      })))

/** Validates changes (shape, existing path, value, AA contrast); returns the new tokens and a before/after diff, or throws. */
export function applyChanges(tokens: Tokens, input: unknown): { tokens: Tokens; diff: string } {
  if (!Array.isArray(input)) throw new Error("changes: expected an array of { path, value, reason }")
  const next = structuredClone(tokens), current = new Map(leaves(tokens))
  const diff = input.map((change: unknown, index) => {
    const fields = isRecord(change) ? Object.keys(change).sort().join() : ""
    if (!isRecord(change) || fields !== "path,reason,value" || !Object.values(change).every((field) => typeof field === "string" && /\S/.test(field)))
      throw new Error(`changes[${index}]: expected exactly non-empty strings path, value and reason`)
    const { path, value, reason } = change as unknown as TokenChange
    if (!current.has(path)) throw new Error(`unknown token path: ${path}`)
    const keys = path.split("."), leaf = keys.pop()!
    const parent = keys.reduce<any>((at, key) => at[key], next)
    const line = `# ${reason}\n- ${path}: ${parent[leaf]}\n+ ${path}: ${value}`
    parent[leaf] = value
    return line
  })
  const result = parseTokens(next), issues = contrastIssues(result)
  if (issues.length) throw new Error(issues.join("\n"))
  return { tokens: result, diff: diff.join("\n") }
}
