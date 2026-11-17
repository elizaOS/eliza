import { type Tokens, palette } from "./tokens.ts"

const hex = "#(?:[\\da-f]{3,4}|[\\da-f]{6}|[\\da-f]{8})"
const functional = "(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix|light-dark)\\("
// CSS's named colors; `transparent` and `currentColor` name no color of their own.
const named = "(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgr[ae]y|darkgreen|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategr[ae]y|darkturquoise|darkviolet|deeppink|deepskyblue|dimgr[ae]y|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gr[ae]y|green|greenyellow|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgr[ae]y|lightgreen|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategr[ae]y|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategr[ae]y|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)"
// In a style, a color anywhere in a value; elsewhere a whole hex or a color function, so "#orders" and "Order #1042" pass.
const inStyle = new RegExp(`(?<![\\w&-])(?:${hex}\\b|${functional}|${named}(?![\\w-]))`, "i")
const anywhere = new RegExp(`^${hex}$|(?<![\\w&[/-])${functional}`, "i")
// A style object's property that holds a color, wherever the object is declared.
const colored = /color$|^(?:background|border|outline|boxShadow|textShadow|textDecoration|columnRule|fill|stroke)/i

interface Node { type: string; parent?: Node; name?: { name?: string }; key?: { name?: string } }
const attribute = (node: Node | undefined): string | undefined => node && (node.type === "JSXAttribute" ? node.name?.name : attribute(node.parent))
// An anchor or an id may spell a hex: "#feed".
const names = /^(?:href|id|htmlFor|to)$/

interface Context {
  sourceCode: { getAllComments(): { value: string; loc?: object | null }[] }
  report(problem: object): void
}
const noLiteralColors = {
  meta: {
    type: "problem" as const,
    schema: [],
    messages: {
      literal: "Literal color in \"{{value}}\". Use a token: var(--primary), bg-primary, text-muted-foreground …",
      reason: "Say why the tokens do not fit: eslint-disable-next-line design-system/no-literal-colors -- <reason>",
    },
  },
  create(context: Context) {
    const report = (node: Node, value: unknown) => {
      const within = attribute(node), holder = node.parent?.type === "TemplateLiteral" ? node.parent.parent : node.parent
      const style = within === "style" || holder?.type === "Property" && colored.test(holder.key?.name ?? "")
      if (typeof value === "string" && !names.test(within ?? "") && (style ? inStyle : anywhere).test(value.trim())) context.report({ node, messageId: "literal", data: { value } })
    }
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments())
          if (/eslint-disable.*design-system\/no-literal-colors(?!.* -- \S)/.test(comment.value) && comment.loc) context.report({ loc: comment.loc, messageId: "reason" })
      },
      Literal: (node: Node & { value?: unknown }) => report(node, node.value),
      TemplateElement: (node: Node & { value: { cooked?: string | null } }) => report(node, node.value.cooked),
    }
  },
}

const variants = "^(?:.+:)?!?"
const opacity = "(?:/[^!]+)?!?$"
// Tailwind's own sizes of a shadow and of a radius; the tokens define some of them.
const sizes = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]
// The radii generate.ts derives from `radius`; tokens.rounded names more.
const derived = ["sm", "md", "lg", "xl"]
// Tailwind's own values of each scale a project may declare; once it declares one, only its own names are allowed there.
const scales = {
  text: { utility: "text", what: "font size", builtIn: ["xs", "sm", "base", "lg", "xl", "[2-9]xl"] },
  weight: { utility: "font", what: "font weight", builtIn: ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black", "\\d+"] },
  leading: { utility: "leading", what: "line height", builtIn: ["none", "tight", "snug", "normal", "relaxed", "loose", "px", "\\d+(?:\\.\\d+)?"] },
  tracking: { utility: "-?tracking", what: "letter spacing", builtIn: ["tighter", "tight", "normal", "wide", "wider", "widest"] },
  z: { utility: "-?z", what: "z-index", builtIn: ["\\d+"] },
}

/**
 * Flat-config entries that hold `.ts`/`.tsx` to the tokens. The caller passes the eslint-plugin-better-tailwindcss
 * module, the parsed tokens.json and the Tailwind entry (generated/theme.css), and configures its own parser.
 */
export function designSystem<Plugin>({ tailwind, tokens, entryPoint }: { tailwind: Plugin; tokens: Tokens; entryPoint: string }) {
  const names = (group: object, prefix = "") => Object.keys(group).map((name) => prefix + name).join(", ")
  const besides = (tokens: string[]) => sizes.filter((size) => !tokens.includes(size)).join("|")
  const colors = `Use a color token: ${names(tokens.color.light)}.`
  const radii = [...derived, ...Object.keys(tokens.rounded)]
  const radius = `Use a radius token:${radii.map((size) => `rounded-${size}`).join(", ")}.`
  // A declared name is never refused, even where it matches a built-in pattern (`z-10`, `leading-6`).
  const declared = Object.entries(scales).flatMap(([group, { utility, what, builtIn }]) => {
    const own = Object.keys(tokens[group as keyof typeof scales])
    if (!own.length) return []
    const use = `Use a ${what} token: ${own.map((name) => `${utility.replace("-?", "")}-${name}`).join(", ")}.`
    return [
      { pattern: `${variants}${utility}-[[(].+[\\])]${opacity}`, message: `"$0" is an arbitrary ${what}. ${use}` },
      { pattern: `${variants}${utility}-(?!(?:${own.join("|")})${opacity})(?:${builtIn.join("|")})${opacity}`, message: `"$0" is a ${what} the tokens do not define. ${use}` },
    ]
  })
  const shadow = `Use a shadow token: ${names(tokens.shadow, "shadow-")}.`
  // Tailwind's default palette stays in the theme for third-party markup but is not ours to use.
  const restrict = [
    { pattern: `${variants}[a-z-]+-(?:(?:${palette})-\\d{2,3}|white|black)${opacity}`, message: `"$0" is a palette color. ${colors}` },
    { pattern: `${variants}[a-z-]+-\\[(?:[^\\]]*(?:#[\\da-fA-F]{3,8}|${functional})[^\\]]*|(?:color:)?${named})\\]${opacity}`, message: `"$0" is an arbitrary color. ${colors}` },
    { pattern: `${variants}rounded(?:-[a-z]{1,2})?-\\[.+\\]!?$`, message: `"$0" is an arbitrary radius. ${radius}` },
    { pattern: `${variants}rounded(?:-[a-z]{1,2})?-(?:${besides(radii)})!?$`, message: `"$0" is a radius the tokens do not define. ${radius}` },
    { pattern: `${variants}shadow-\\[.+\\]!?$`, message: `"$0" is an arbitrary shadow. ${shadow}` },
    { pattern: `${variants}shadow-(?:${besides(Object.keys(tokens.shadow))})!?$`, message: `"$0" is a shadow the tokens do not define. ${shadow}` },
    { pattern: `${variants}font-serif!?$`, message: `"$0" is a font the tokens do not define. Use a font token: ${names(tokens.font, "font-")}.` },
    ...declared,
  ]
  return [{
    files: ["**/*.{ts,tsx}"],
    plugins: { "better-tailwindcss": tailwind },
    settings: { "better-tailwindcss": { entryPoint } },
    rules: {
      "better-tailwindcss/no-unknown-classes": "error" as const,
      "better-tailwindcss/no-conflicting-classes": "error" as const,
      "better-tailwindcss/no-restricted-classes": ["error", { restrict }] as ["error", object],
    },
  }, {
    files: ["**/*.tsx"],
    plugins: { "design-system": { rules: { "no-literal-colors": noLiteralColors } } },
    rules: { "design-system/no-literal-colors": "error" as const },
  }]
}
