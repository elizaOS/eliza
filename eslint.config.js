import { existsSync, readdirSync, readFileSync } from "node:fs"
import js from "@eslint/js"
import react from "@eslint-react/eslint-plugin"
import tailwind from "eslint-plugin-better-tailwindcss"
import boundaries from "eslint-plugin-boundaries"
import reactHooks from "eslint-plugin-react-hooks"
import { defineConfig, globalIgnores } from "eslint/config"
import tseslint from "typescript-eslint"
import vibelang from "vibelang/eslint"
import { designSystem } from "./vibestack/design/eslint.ts"
import { parseTokens } from "./vibestack/design/tokens.ts"

const stack = 'AGENTS.md, "The stack"'
const monorepo = 'CONTRIBUTING.md, "The monorepo"'
const banned = ["redux", "react-redux", "zustand", "mobx", "jotai", "recoil", "valtio", "xstate", "vue", "svelte", "jest"]
const scopes = ["reduxjs", "angular", "xstate", "vue", "sveltejs", "jest"]
// Each workspace package's `exports` beyond its root: "@repo/design-system/theme.css".
const exported = readdirSync("packages").filter((dir) => existsSync(`packages/${dir}/package.json`)).flatMap((dir) => {
  const { name, exports = {} } = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"))
  return Object.keys(exports).filter((key) => key !== ".").map((key) => RegExp.escape(`${name}/${key.slice(2)}`))
})
const imports = {
  patterns: [
    // A package, its subpaths and its family: zustand/middleware, redux-saga, @angular/core.
    { regex: `^(?:@(?:${scopes.join("|")})/|(?:${banned.join("|")})(?:[/-]|$))`, message: `Not part of the stack: ${stack}.` },
    { regex: `^(?!(?:${exported.join("|")})$)@repo/[^/]+/`, message: `Import a workspace package by a path its "exports" names: ${monorepo}.` },
  ],
}
const noReact = { patterns: [...imports.patterns, { regex: "^react(?:-dom)?(?:/|$)", message: `Tool and domain code does not import React: ${monorepo}.` }] }
// What no tsconfig.json includes, so the type-aware rules cannot see it.
const untyped = ["*.{js,ts}", "**/.storybook/**", "packages/design-system/**", "vibestack/design/test/**", "vibestack/stories/test/**"]
// Every React interface: Studio's page is built on the same theme (vibestack/studio/vite.config.ts).
const tsx = ["packages/ui/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}", "vibestack/studio/src/page/**/*.{ts,tsx}"]
const design = "packages/design-system"
const writing = 'AGENTS.md, "Writing code"'
const citation = String.raw`spec\/\S+\.md, "[^"]+"`
const suppressible = String.raw`(?!code\/|no-console\b)[\w@/-]+`
const cited = new RegExp(String.raw`^\s*${citation}(?:; ${citation})*\s*$`)
const suppression = new RegExp(String.raw`^ eslint-disable(?:-next-line|-line)? ${suppressible}(?:, ${suppressible})* -- \S`)
const directives = {
  Line: [cited, suppression, /^@ (?:backend|requires|ensures|invariant|decreases|assert|pure|type|ghost)(?: |$)/, /^\/ <reference /, /^ @vitest-environment [\w-]+$/],
  Block: [cited, suppression, /^ eslint-enable\b/],
  Shebang: [/^/],
}
const comments = {
  meta: { type: "problem", schema: [{ type: "object", properties: { jsdoc: { type: "boolean" } }, additionalProperties: false }] },
  create: (context) => ({
    Program: () => context.sourceCode.getAllComments()
      .filter((comment) => !directives[comment.type].some((directive) => directive.test(comment.value)) && !(context.options[0]?.jsdoc && comment.type === "Block" && comment.value.startsWith("*")))
      .forEach((comment) => context.report({ loc: comment.loc, message: `No code comments: only spec citations and tool directives (${writing}).` })),
  }),
}
const uses = (names) => `:matches(CallExpression[callee.name=${names}], CallExpression[callee.property.name=${names}], ImportSpecifier[imported.name=${names}])`
const scheduling = {
  [uses(/^use(?:Layout|Insertion)?Effect$/)]: `No effect hooks: shared state lives in the spec-backed Machine (${writing}).`,
  [uses(/^(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)$/)]: `No timers: wait with Effect in VibeLang, or let the Machine say when (${writing}).`,
}
const effects = {
  meta: { type: "problem", schema: [] },
  create: (context) => Object.fromEntries(Object.entries(scheduling).map(([selector, message]) => [selector, (node) => context.report({ node, message })])),
}
const code = { rules: { comments, effects } }
const own = ["apps/**", "packages/**"]
const commented = ["apps/app/src/{App.tsx,greeter.vibe,greeting.ts,link.contract.ts,link.ts}", "apps/app/test/{app.browser.test.tsx,app.test.vibe,bombadil.ts,drivers/app.ts}", "packages/ui/.storybook/preview.ts", "packages/ui/src/components/{Button,Button.meta,Card.meta,Dialog.meta,Progress}.tsx", "packages/ui/src/lib/cn.ts", "packages/ui/{vite,vitest}.config.ts"]
const scheduled = ["apps/app/src/App.tsx"]

// The tool reads Quint's JSON and the TypeScript compiler API as `any` at its boundaries; packages and apps stay strict.
const loose = Object.fromEntries(["no-explicit-any", "no-unsafe-argument", "no-unsafe-assignment", "no-unsafe-call", "no-unsafe-member-access", "no-unsafe-return"].map((rule) => [`@typescript-eslint/${rule}`, "off"]))

export default defineConfig(
  // Generated or disposable, and .claude/worktrees holds other checkouts of this repository.
  globalIgnores(["**/gen/", "!vibestack/gen/", "**/.vibe/", "**/dist/", "**/.cache/", "**/.spec-cache/", "**/generated/", "**/storybook-static/", "**/test/fixtures/", "vibestack/examples/", "vibestack/fixtures/", ".claude/", ".lemmascript/", ".studio/", ".turbo/", "_apalache-out/"]),
  { linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" } },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "package", pattern: ["packages/*", "apps/*"], capture: ["name"] },
        { type: "studio", pattern: "vibestack/studio" },
        { type: "tool", pattern: "vibestack" },
      ],
    },
    rules: {
      "no-restricted-imports": ["error", imports],
      // A relative path stays inside its package; the tool and Studio, which ships inside it, import each other.
      "boundaries/dependencies": ["error", {
        default: "disallow",
        policies: [
          { from: { element: { type: "package" } }, allow: { to: { element: { type: "package", captured: { name: "{{ from.element.captured.name }}" } } } } },
          { from: { element: { types: ["tool", "studio"] } }, allow: { to: { element: { types: ["tool", "studio"] } } } },
        ],
      }],
      // Nor does it reach a file outside every package and the tool.
      "boundaries/no-unknown-dependencies": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      // node:test runs what `test` and `describe` return; an async event listener is awaited by nobody by design.
      "@typescript-eslint/no-floating-promises": ["error", { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it"] }] }],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      // Regular expressions here match the tools' column-aligned output, where literal spaces read as the output does.
      "no-regex-spaces": "off",
      // AGENTS.md, "Writing code": one path, so nothing is left for later or kept beside its replacement.
      "no-warning-comments": ["error", { terms: ["todo", "fixme", "legacy", "deprecated"], location: "anywhere" }],
    },
  },
  { files: untyped, extends: [tseslint.configs.disableTypeChecked] },
  // A ratchet at today's longest (Studio's server); a test's describe block holds its cases.
  { ignores: ["**/test/**", "vibestack/selftest.ts"], rules: { "max-lines-per-function": ["error", { max: 250, skipBlankLines: true, skipComments: true }] } },
  {
    files: ["vibestack/**"],
    ignores: ["**/*.tsx"],
    rules: {
      ...loose,
      // `value!` after a check the compiler cannot follow is this code's style, also where a later TypeScript made it redundant.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // `unknown | Promise<unknown>` and `Json | undefined` document intent although `unknown` and `any` absorb the rest.
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // The TypeScript API compares masked flags: `(flags & NodeFlags.BlockScoped) === NodeFlags.Const`.
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      // Node types execFile's error as an intersection of Omit<>s, which the rule does not see is an Error.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      // The compiler host's methods and a driver's functions are passed around as plain functions that use no `this`.
      "@typescript-eslint/unbound-method": "off",
      // Studio's DOM helpers stringify attribute values and children typed `unknown`.
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
  // VibeLang's parser gives .vibe files typescript-eslint's tree without a program, so the rules that need types stay off: `vibelang --noEmit` checks them.
  { files: ["**/*.{vibe,vibex}"], extends: [tseslint.configs.disableTypeChecked], languageOptions: { parser: vibelang, parserOptions: { projectService: false } }, rules: { "no-undef": "off" } },
  // React belongs to interfaces: the tools apart from Studio's page, and schemas, contracts, drivers and the shell everywhere, do without it.
  {
    files: ["vibestack/**", "**/*.{schema,contract}.ts", "**/test/drivers/**", "**/*.vibe"],
    ignores: ["vibestack/studio/src/page/**"],
    rules: { "no-restricted-imports": ["error", noReact] },
  },
  // eslint-plugin-react-hooks owns the rules both plugins ship; @eslint-react adds the rest.
  {
    files: ["**/*.tsx"],
    extends: [react.configs["recommended-type-checked"], reactHooks.configs.flat.recommended],
    rules: Object.fromEntries(Object.keys(reactHooks.rules).filter((rule) => `@eslint-react/${rule}` in react.configs["recommended-type-checked"].rules).map((rule) => [`@eslint-react/${rule}`, "off"])),
  },
  // vibestack/design/eslint.ts: token classes only, read from the theme `pnpm --filter @repo/design-system build` writes.
  {
    files: tsx,
    extends: [designSystem({ tailwind, tokens: parseTokens(JSON.parse(readFileSync(`${design}/tokens.json`, "utf8"))), entryPoint: `${import.meta.dirname}/${design}/generated/theme.css` })],
    settings: { "better-tailwindcss": { cwd: design } },
  },
  // @repo/ui holds the form controls and dialogs every interface uses.
  {
    files: tsx,
    ignores: ["packages/ui/**"],
    rules: {
      "no-restricted-globals": ["error", ...["alert", "confirm", "prompt"].map((name) => ({ name, message: "Use Dialog or Alert from @repo/ui." }))],
      "no-restricted-syntax": ["error", { selector: "JSXOpeningElement[name.name=/^(input|textarea)$/]", message: "Use Input, Textarea or Checkbox from @repo/ui." }],
    },
  },
  { files: own, plugins: { code }, rules: { "no-console": "error" } },
  { files: own, ignores: commented, rules: { "code/comments": "error" } },
  { files: ["packages/ui/src/components/**"], ignores: ["**/*.meta.tsx", ...commented], rules: { "code/comments": ["error", { jsdoc: true }] } },
  { files: own, ignores: scheduled, rules: { "code/effects": "error" } },
)
