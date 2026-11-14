import type { Tokens } from "./tokens.ts"

const hex = "#(?:[\\da-f]{3,4}|[\\da-f]{6}|[\\da-f]{8})"
const functional = "(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\\("
// In a style, a color anywhere in a value; elsewhere a whole hex or a color function, so "#orders" and "Order #1042" pass.
const inStyle = new RegExp(`(?<![\\w&-])(?:${hex}\\b|${functional})`, "i")
const anywhere = new RegExp(`^${hex}$|(?<![\\w&[/-])${functional}`, "i")

interface Node { type: string; parent?: Node; name?: { name?: string } }
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
      const within = attribute(node)
      if (typeof value === "string" && !names.test(within ?? "") && (within === "style" ? inStyle : anywhere).test(value.trim())) context.report({ node, messageId: "literal", data: { value } })
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

// Tailwind's default palette, which stays in the theme for third-party markup but is not ours to use.
const palettes = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose"
const variants = "^(?:.+:)?"

/**
 * Flat-config entries that hold `.ts`/`.tsx` to the tokens. The caller passes the eslint-plugin-better-tailwindcss
 * module, the parsed tokens.json and the Tailwind entry (generated/theme.css), and configures its own parser.
 */
export function designSystem<Plugin>({ tailwind, tokens, entryPoint }: { tailwind: Plugin; tokens: Tokens; entryPoint: string }) {
  const names = (group: object, prefix = "") => Object.keys(group).map((name) => prefix + name).join(", ")
  const colors = `Use a color token: ${names(tokens.color.light)}.`
  const restrict = [
    { pattern: `${variants}[a-z-]+-(?:${palettes})-\\d{2,3}(?:/.+)?$`, message: `"$0" is a palette color. ${colors}` },
    { pattern: `${variants}!?[a-z-]+-\\[[^\\]]*(?:#[\\da-fA-F]{3,8}|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\\()[^\\]]*\\](?:/[^!]+)?!?$`, message: `"$0" is an arbitrary color. ${colors}` },
    { pattern: `${variants}rounded(?:-[a-z]{1,2})?-\\[.+\\]$`, message: `"$0" is an arbitrary radius. Use the radius token: rounded-sm, rounded-md, rounded-lg, rounded-xl.` },
    { pattern: `${variants}shadow-\\[.+\\]$`, message: `"$0" is an arbitrary shadow. Use a shadow token: ${names(tokens.shadow, "shadow-")}.` },
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
