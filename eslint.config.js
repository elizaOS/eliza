import { readFileSync } from "node:fs"
import { relative, sep } from "node:path"
import js from "@eslint/js"
import react from "@eslint-react/eslint-plugin"
import tailwind from "eslint-plugin-better-tailwindcss"
import boundaries from "eslint-plugin-boundaries"
import reactHooks from "eslint-plugin-react-hooks"
import { defineConfig, globalIgnores } from "eslint/config"
import { builtinRules } from "eslint/use-at-your-own-risk"
import tseslint from "typescript-eslint"
import vibelang from "vibelang/eslint"
import { designSystem } from "./vibestack/design/eslint.ts"
import { parseTokens } from "./vibestack/design/tokens.ts"
import { withWorkspaceBarrels } from "./vibestack/eslint.ts"

const stack = 'AGENTS.md, "The stack"'
const monorepo = 'CONTRIBUTING.md, "The monorepo"'
const banned = ["redux", "react-redux", "zustand", "mobx", "jotai", "recoil", "valtio", "xstate", "vue", "svelte", "jest"]
const scopes = ["reduxjs", "angular", "xstate", "vue", "sveltejs", "jest"]
const imports = {
  patterns: [
    // A package, its subpaths and its family: zustand/middleware, redux-saga, @angular/core.
    { regex: `^(?:@(?:${scopes.join("|")})/|(?:${banned.join("|")})(?:[/-]|$))`, message: `Not part of the stack: ${stack}.` },
  ],
}
const noReact = { patterns: [...imports.patterns, { regex: "^react(?:-dom)?(?:/|$)", message: `Tool and domain code does not import React: ${monorepo}.` }] }
// What no tsconfig.json includes, so the type-aware rules cannot see it.
const untyped = ["*.{js,ts}", "**/.storybook/**", "packages/design-system/**", "vibestack/design/test/**", "vibestack/stories/test/**"]
// Every React interface: Studio's page is built on the same theme (vibestack/studio/vite.config.ts).
const tsx = ["packages/ui/**/*.{ts,tsx}", "packages/cloud-worker/src/pages/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}", "vibestack/studio/src/page/**/*.{ts,tsx}"]
const design = "packages/design-system"
const writing = 'AGENTS.md, "Writing code"'
const citation = String.raw`spec\/\S+\.md, "[^"]+"`
const suppressible = String.raw`(?!code\/|barrel\/|no-console\b)[\w@/-]+`
const cited = new RegExp(String.raw`^\s*${citation}(?:; ${citation})*\s*$`)
const suppression = new RegExp(String.raw`^ eslint-disable(?:-next-line|-line)? ${suppressible}(?:, ${suppressible})* -- \S`)
const configs = [suppression, /^ eslint-enable\b/]
const throwsType = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`
const throwsDirective = new RegExp(String.raw`^\*(?:[\s*]*@throws \{[ \t]*${throwsType}(?:[ \t]*\|[ \t]*${throwsType})*[ \t]*\})+[\s*]*$`)
const directives = {
  Line: [cited, suppression, /^@ (?:backend|requires|ensures|invariant|decreases|assert|pure|type|ghost)(?: |$)/, /^\/ <reference /, /^ @vitest-environment [\w-]+$/],
  Block: [cited, ...configs, /^\*(?:[\s*]*@(?:model|design) \S+)+[\s*]*$/, throwsDirective],
  Shebang: [/^/],
}
const inline = /^\s*(?:eslint(?:-[a-z]+)*|exported|globals?)(?:\s|$)/
const guarded = (parser) => ({
  meta: { name: `${parser.meta.name} with code/inline`, version: parser.meta.version },
  parseForESLint: (text, options) => {
    const parsed = parser.parseForESLint(text, options)
    const loose = parsed.ast.comments.find((comment) => inline.test(comment.value) && !configs.some((form) => form.test(comment.value)))
    if (loose) throw Object.assign(new SyntaxError(`Inline config here is only "eslint-disable[-next-line|-line] <rule>, … -- <reason>", never for code/*, barrel/* or no-console, and "eslint-enable" (${writing}).`), { lineNumber: loose.loc.start.line, column: loose.loc.start.column + 1 })
    return parsed
  },
})
const within = (node) => Boolean(node) && (/Function/.test(node.type) || within(node.parent))
const documented = (context, comment) => context.options[0]?.jsdoc && comment.type === "Block" && comment.value.startsWith("*") && !within(context.sourceCode.getNodeByRangeIndex(comment.range[0]))
const left = { type: "object", additionalProperties: { type: "integer", minimum: 1 } }
const excess = (context, found) => found.length > (context.options[0]?.left?.[relative(context.cwd, context.filename).split(sep).join("/")] ?? 0) && found.forEach((problem) => context.report(problem))
const toolDirective = (context, comment) => {
  if (comment.type !== "Block") return false
  if (/^\*\s*@public\s*$/.test(comment.value)) return true
  if (comment.value.trim() !== "@vite-ignore") return false
  let node = context.sourceCode.getNodeByRangeIndex(comment.range[0])
  while (node && node.type !== "ImportExpression") node = node.parent
  return Boolean(node)
}
const comments = {
  meta: { type: "problem", schema: [{ type: "object", properties: { jsdoc: { type: "boolean" }, left }, additionalProperties: false }] },
  create: (context) => ({
    Program: () => excess(context, context.sourceCode.getAllComments()
      .filter((comment) => !directives[comment.type].some((directive) => directive.test(comment.value)) && !documented(context, comment) && !toolDirective(context, comment))
      .map((comment) => ({ loc: comment.loc, message: `No code comments: only spec citations and tool directives (${writing}).` }))),
  }),
}
const uses = (names) => `:matches(Identifier[name=${names}]:not(ImportSpecifier[imported.name=${names}] > Identifier.local):not(ObjectExpression > Property[computed=false][shorthand=false] > Identifier.key), MemberExpression[computed=true] > Literal.property[value=${names}])`
const scheduling = {
  [uses(/^use(?:Layout|Insertion)?Effect$/)]: `No effect hooks: shared state lives in the spec-backed Machine (${writing}).`,
  [uses(/^(?:setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|requestIdleCallback)$/)]: `No timers: wait with Effect in VibeLang, or let the Machine say when (${writing}).`,
}
const effects = {
  meta: { type: "problem", schema: [{ type: "object", properties: { left }, additionalProperties: false }] },
  create: (context) => {
    const found = []
    return { ...Object.fromEntries(Object.entries(scheduling).map(([selector, message]) => [selector, (node) => found.push({ node, message })])), "Program:exit": () => excess(context, found) }
  },
}
const consoleRule = builtinRules.get("no-console")
const countedConsole = {
  meta: { ...consoleRule.meta, schema: [{ type: "object", properties: { left }, additionalProperties: false }] },
  create: (context) => {
    const found = []
    const visitor = consoleRule.create(Object.create(context, { report: { value: (problem) => found.push(problem) } }))
    return { ...visitor, "Program:exit": (node) => { visitor["Program:exit"]?.(node); excess(context, found) } }
  },
}
const code = { rules: { comments, effects, console: countedConsole } }
const own = ["apps/**", "packages/**"]
const commented = {
  "packages/agent/src/client/device-execution.vibe": 1,
  "packages/agent/src/voice/capture.worklet.mjs": 1,
  "packages/cloud-worker/src/google-read.vibe": 1,
  "packages/cloud-worker/src/services/google/mail-read.vibe": 1,
  "packages/core/src/retrieval.vibe": 21,
}
const scheduled = {
  "packages/agent-host/src/access/socket.vibe": 2,
  "packages/agent-host/test/client-runtime.test.vibe": 2,
  "packages/agent-host/test/client-tasks.test.vibe": 1,
  "packages/agent-host/test/client-turns.test.vibe": 2,
  "packages/agent-host/test/device-read-completion.test.vibe": 1,
  "packages/agent-host/test/device-telephony.test.vibe": 1,
  "packages/agent-host/test/events.test.vibe": 2,
  "packages/agent-host/test/http.test.vibe": 2,
  "packages/agent-host/test/schedule-triggers.test.vibe": 1,
  "packages/agent-host/test/scheduled-tasks.test.vibe": 1,
  "packages/agent/test/support/audio-fake.ts": 2,
  "packages/agent-host/test/transport.test.vibe": 2,
  "packages/agent/test/voice-playback.test.vibe": 1,
  "packages/agent/test/voice-recorded-transcription.test.vibe": 1,
  "packages/core/src/runtime/provider-execution.vibe": 1,
  "packages/core/src/services/task.vibe": 6,
  "packages/core/src/utils/retry.vibe": 1,
  "packages/os-bridges/src/bridges/voice.vibe": 1,
  "packages/os-bridges/test/bridges/messages.test.vibe": 1,
}
const consoleCounts = { "packages/core/src/logger.vibe": 3 }

const unused = { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
const coreUnused = { ...unused, ignoreRestSiblings: true }

// The tool reads Quint's JSON and the TypeScript compiler API as `any` at its boundaries; packages and apps stay strict.
const loose = Object.fromEntries(["no-explicit-any", "no-unsafe-argument", "no-unsafe-assignment", "no-unsafe-call", "no-unsafe-member-access", "no-unsafe-return"].map((rule) => [`@typescript-eslint/${rule}`, "off"]))

export default withWorkspaceBarrels(defineConfig(
  // Generated or disposable, .claude/worktrees holds other checkouts of this repository, and os ships the Android, AOSP, browser and Go trees it copies as files.
  globalIgnores(["**/gen/", "!vibestack/gen/", "**/.vibe/", "**/dist/", "**/.cache/", "**/.spec-cache/", "**/generated/", "**/storybook-static/", "**/test/fixtures/", "packages/os/{android,aosp,browser,native}/", "vibestack/examples/", "vibestack/fixtures/", ".claude/", ".lemmascript/", ".studio/", ".turbo/", "_apalache-out/"]),
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
      "@typescript-eslint/no-unused-vars": ["error", unused],
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
  // VibeLang's parser gives .vibe files a TypeScript tree without a program; `vibelang --noEmit` checks bindings, separate type and value namespaces, and types.
  { files: ["**/*.{vibe,vibex}"], extends: [tseslint.configs.disableTypeChecked], languageOptions: { parser: vibelang, parserOptions: { projectService: false } }, rules: { "no-undef": "off", "no-redeclare": "off" } },
  {
    files: ["packages/os/src/browser/**/*.vibe"],
    settings: {
      "import/resolver": {
        typescript: { project: "packages/os/tsconfig.json", alwaysTryTypes: false },
        node: {},
      },
    },
  },
  { files: ["packages/core/**/*.{ts,tsx,vibe,vibex}"], rules: { "no-redeclare": "off", "@typescript-eslint/no-unused-vars": ["error", coreUnused] } },
  { files: ["packages/core/**/*.{vibe,vibex}"], rules: { "no-empty": ["error", { allowEmptyCatch: true }] } },
  { files: ["packages/{agent,agent-host}/**/*.{vibe,vibex}"], rules: { "no-empty": ["error", { allowEmptyCatch: true }] } },
  { files: ["packages/agent/src/access/routes.vibe", "packages/agent/src/client/index.vibe", "packages/agent/src/host/launch.schema.vibe"], rules: { "no-control-regex": "off" } },
  { files: ["packages/**/*.{vibe,vibex}"], rules: { "no-redeclare": "off" } },
  { files: ["packages/cloud/src/client/relay-frames.ts", "packages/cloud/src/services/sse.ts"], rules: { "prefer-const": "off", "@typescript-eslint/no-unused-vars": ["error", { ...unused, argsIgnorePattern: "^(?:_|id$|pcm$|frame$|s$|a$|b$|d$)" }] } },
  { files: ["packages/agent/src/voice/echo-filter.ts"], rules: { "@typescript-eslint/no-unused-vars": ["error", { ...unused, varsIgnorePattern: "^(?:_|echoOverlapPercent$|isEcho$|turnAccepted$)" }] } },
  {
    files: ["packages/core/src/types/service.vibe", "packages/core/src/types/service-interfaces.vibe"],
    rules: { "@typescript-eslint/no-empty-object-type": ["error", { allowWithName: "^(?:ServiceTypeRegistry|StoredPrivateFile)$" }] },
  },
  { files: ["packages/core/src/runtime.vibe"], rules: { "@typescript-eslint/no-unsafe-declaration-merging": "off" } },
  {
    files: ["packages/core/src/logger.vibe", "packages/core/src/messaging/interactive-task.vibe", "packages/core/src/retrieval.vibe", "packages/core/src/utils/stage-directions.vibe"],
    rules: { "no-control-regex": "off" },
  },
  {
    files: ["packages/core/src/runtime/pipeline-hooks.vibe", "packages/core/src/utils/task-scheduling.vibe"],
    rules: { "no-useless-assignment": "off" },
  },
  {
    files: ["packages/core/src/memory.vibe", "packages/core/src/messaging/interaction-profiles.vibe", "packages/core/src/messaging/task-events.vibe", "packages/core/src/messaging/task-widgets.vibe", "packages/core/src/runtime/context-registry.vibe", "packages/core/src/runtime/model-dispatch.vibe", "packages/core/src/runtime/room-handler-queue.vibe", "packages/core/src/runtime/run-terminal-owner.vibe", "packages/core/src/security/pii-pseudonymizer.vibe", "packages/core/src/security/pii-scrub-seam.vibe", "packages/core/src/types/provider-integrations.vibe", "packages/core/src/utils/unicode.vibe"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { ...coreUnused, varsIgnorePattern: "^(?:_|ContextRegistryError$|ElizaError$|Foreign$|PiiScrubFabricationError$)" }] },
  },
  {
    files: ["packages/core/src/catalog/loader.vibe"],
    rules: { "no-warning-comments": ["error", { terms: ["todo", "fixme", "deprecated"], location: "anywhere" }] },
  },
  // React belongs to interfaces: the tools apart from Studio's page, the owners apart from cloud-worker's pages, and schemas, contracts, drivers and the shell everywhere, do without it.
  {
    files: ["vibestack/**", "packages/{core,core-node,cloud,cloud-worker,agent,agent-host,os,os-bridges}/**", "**/*.{schema,contract}.ts", "**/test/drivers/**", "**/*.vibe"],
    ignores: ["vibestack/studio/src/page/**", "packages/cloud-worker/src/pages/**"],
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
  { files: own, ignores: ["**/*.{vibe,vibex}"], languageOptions: { parser: guarded(tseslint.parser) } },
  { files: ["{apps,packages}/**/*.{vibe,vibex}"], languageOptions: { parser: guarded(vibelang) } },
  { files: own, plugins: { code }, rules: { "no-console": "error", "code/comments": ["error", { left: commented }], "code/effects": ["error", { left: scheduled }] } },
  { files: ["packages/ui/src/components/**"], ignores: ["**/*.meta.tsx"], rules: { "code/comments": ["error", { jsdoc: true, left: commented }] } },
  { files: Object.keys(consoleCounts), rules: { "no-console": "off", "code/console": ["error", { left: consoleCounts }] } },
), {
  root: import.meta.dirname,
  // The Android, AOSP and browser trees os ships as files: downstream Android packaging resolves them through these keys.
  allowExports: {
    "packages/os/package.json": ["./browser/runtime/*", "./browser/protection/*", "./browser/chromium/component/*", "./android/*", "./aosp/*"],
  },
})

if (import.meta.main) {
  const { spawn, spawnSync } = await import("node:child_process")
  const { availableParallelism, constants } = await import("node:os")
  const { default: process } = await import("node:process")
  const { setTimeout, clearTimeout } = await import("node:timers")
  const vibeFiles = "**/*.{vibe,vibex}"
  const packageGroups = [
    [
      "packages/agent",
      "packages/agent-host",
      "packages/plugin-assistant",
      "packages/plugin-assistant-client",
      "packages/plugin-browser",
      "packages/plugin-browser-client",
      "packages/cloud",
      "packages/cloud-worker",
      "packages/core",
      "packages/core-node",
      "packages/plugin-localinference",
      "packages/plugin-localinference-client",
      "packages/os",
      "packages/os-bridges",
    ],
    [
      "packages/plugin-calendar",
      "packages/plugin-calendar-client",
      "packages/plugin-files",
      "packages/plugin-files-client",
      "packages/plugin-inbox",
      "packages/plugin-inbox-client",
      "packages/plugin-maps",
      "packages/plugin-maps-client",
      "packages/plugin-notes",
      "packages/plugin-notes-client",
      "packages/ui",
      "packages/plugin-workflows",
      "packages/plugin-workflow-client",
      "packages/plugin-workflow-worker",
      "vibestack/studio",
    ],
  ]
  const ignoreVibe = ["--ignore-pattern", vibeFiles]
  const ignorePackages = packageGroups.flat().flatMap((directory) => ["--ignore-pattern", `${directory}/`])
  const extra = process.argv.slice(2)
  const passes = extra.length
    ? [[".", "--max-warnings", "0", ...extra]]
    : [
      [vibeFiles, "--no-error-on-unmatched-pattern", "--max-warnings", "0"],
      ...packageGroups.map((group) => [...group, ...ignoreVibe, "--no-error-on-unmatched-pattern", "--max-warnings", "0"]),
      [".", ...ignoreVibe, ...ignorePackages, "--max-warnings", "0"],
    ]

  const signalStatus = (signal) => 128 + constants.signals[signal]

  function serial() {
    let status = 0
    for (const args of passes) {
      const result = spawnSync("eslint", args, { stdio: "inherit" })
      if (result.error) throw result.error
      if (result.signal) return signalStatus(result.signal)
      status = Math.max(status, result.status ?? 2)
    }
    return status
  }

  function signalGroup(child, signal) {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code === "ESRCH") return
      if (error.code !== "EPERM") throw error
      child.kill(signal)
    }
  }

  async function overlap([vibe, ...typed]) {
    const active = new Set()
    const held = []
    let stoppingGroups
    let force
    let interrupted
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"]
    const stop = (signal) => {
      if (stoppingGroups) return
      stoppingGroups = [...active]
      for (const child of stoppingGroups) signalGroup(child, signal)
      force = setTimeout(() => {
        for (const child of stoppingGroups) signalGroup(child, "SIGKILL")
      }, 750)
    }
    const interrupt = (signal) => {
      interrupted ??= signal
      stop(interrupted)
    }
    const ttyEnv = process.env.FORCE_COLOR === undefined && process.stdout.hasColors?.()
      ? { ...process.env, FORCE_COLOR: "1" }
      : process.env
    const run = (args, capture) => new Promise((resolve) => {
      try {
        const child = spawn("eslint", args, { detached: true,
          stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
          env: capture ? ttyEnv : process.env })
        active.add(child)
        let error
        child.once("error", (cause) => { error = cause })
        child.once("exit", (_, signal) => {
          if (signal && !stoppingGroups) signalGroup(child, "SIGKILL")
        })
        child.once("close", (status, signal) => {
          active.delete(child)
          resolve({ status, signal, error })
        })
        if (capture) for (const stream of ["stdout", "stderr"]) {
          child[stream].on("data", (chunk) => held.push([stream, chunk]))
        }
      } catch (error) {
        resolve({ error })
      }
    })
    const typedPasses = async () => {
      let status = 0
      for (const args of typed) {
        if (stoppingGroups) break
        const result = await run(args, true)
        if (result.error || result.signal) return result
        status = Math.max(status, result.status ?? 2)
      }
      return { status }
    }
    for (const signal of signals) process.on(signal, interrupt)
    try {
      const first = run(vibe, false)
      const rest = typedPasses()
      const firstResult = await first
      if (firstResult.error || firstResult.signal) stop("SIGTERM")
      const typedResult = await rest
      if (interrupted) return signalStatus(interrupted)
      if (!firstResult.error && !firstResult.signal) {
        for (const [stream, chunk] of held) process[stream].write(chunk)
      }
      for (const result of [firstResult, typedResult]) {
        if (result.error) throw result.error
        if (result.signal) return signalStatus(result.signal)
      }
      return Math.max(firstResult.status ?? 2, typedResult.status ?? 2)
    } finally {
      if (stoppingGroups) for (const child of stoppingGroups) signalGroup(child, "SIGKILL")
      clearTimeout(force)
      for (const signal of signals) process.off(signal, interrupt)
    }
  }

  const standalone = extra.length === 0 && process.env.npm_lifecycle_event === "lint:js"
    && !["CI", "GITHUB_ACTIONS", "TURBO_HASH"].some((name) => name in process.env)
    && process.platform !== "win32" && availableParallelism() > 1 && process.availableMemory() >= 8 * 1024 ** 3

  process.exitCode = standalone ? await overlap(passes) : serial()
}
