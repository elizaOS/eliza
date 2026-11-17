// Knip reads .vibe files through VibeLang's own compiler, which gives it a module's imports and exports without bodies.
// Each exception below names something Knip cannot follow:
//   compilers vibe strips module-block imports  `import { x } from node` is not TypeScript, and one such line makes Knip read no exports of the file
//   ignore vibestack/examples/**            standalone projects with their own install, outside the workspace
//   ignore **/test/fixtures/**              inputs the tools' tests read as text, never imported
//   ignoreIssues server.vibe exports        AGENTS is used in its own file, in a body ignoreExportsUsedInFile cannot see
//   root @informalsystems/quint, lemmascript  run as executables by vibestack/units.ts and vibestack/prove.ts
//   root @vitest/browser                    loaded by Vitest's browser mode, beside @vitest/browser-playwright
//   root @repo/design-system                read as files by vibestack/design/test/design.test.ts
//   tailwindcss (ui, design-system, studio, apps, cloud)  resolved by @tailwindcss/vite and the lint plugin from CSS
//   entry *.schema, *.contract              imported by the tests vibestack/testing/generate.ts writes under .cache/
//   design-system eslint, eslint-plugin-better-tailwindcss, typescript-eslint  loaded by name in vibestack/design/test/design.test.ts
//   os esbuild, punycode, tldts             used by browser/protection, which ships as files outside the package's project
import vibelang from "vibelang/knip"

const vibe = (text, path) => vibelang(text, path).replace(/^import\s+(?:type\s+)?\{[^}"']*\}\s+from\s+[A-Za-z_$][\w$]*\s*$/gm, "")

export default {
  compilers: { vibe, vibex: vibe },
  "ignore": [
    "vibestack/examples/**",
    "**/test/fixtures/**"
  ],
  "ignoreExportsUsedInFile": true,
  "ignoreIssues": {
    "vibestack/studio/src/server.vibe": ["exports"]
  },
  "workspaces": {
    ".": {
      "entry": [
        "vibestack/design/cli.ts",
        "vibestack/stories/cli.ts",
        "vibestack/remote-cache.ts",
        "vibestack/*/test/*.test.ts",
        "vibestack/testing/test/fixture/*/src/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "vibestack/**/*.{ts,tsx,vibe,vibex}",
        "!vibestack/studio/**"
      ],
      "ignoreDependencies": [
        "@informalsystems/quint",
        "lemmascript",
        "@vitest/browser",
        "@repo/design-system"
      ]
    },
    "packages/ui": {
      "entry": [
        "src/**/*.{meta,stories}.tsx"
      ],
      "project": [
        "**/*.{ts,tsx,vibe,vibex,css}"
      ],
      "ignoreDependencies": [
        "tailwindcss"
      ]
    },
    "packages/design-system": {
      "ignoreDependencies": [
        "eslint",
        "eslint-plugin-better-tailwindcss",
        "tailwindcss",
        "typescript-eslint"
      ]
    },
    "vibestack/studio": {
      "entry": [
        "src/main.vibe",
        "src/project.ts",
        "src/doc.ts"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe,vibex,css}",
        "test/**/*.{ts,tsx,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "tailwindcss"
      ]
    },
    "packages/core": {
      "entry": [
        "src/{index,protocol,logging,view-interaction,speech,read-memo,schema-types}.vibe",
        "src/entry/{task-events,task-widgets}.vibe",
        "test/**/*.test.{ts,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,vibe}",
        "test/**/*.{ts,vibe}"
      ],
      "ignoreDependencies": [
        "@effect/platform-node-shared"
      ]
    },
    "packages/cloud": {
      "entry": [
        "src/{index,main}.vibe",
        "src/client/index.vibe",
        "src/profile/profile.vibe",
        "src/pages/render.tsx",
        "test/**/*.test.{ts,vibe}",
        "test/drivers/*.ts",
        "test/bombadil.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe,css}",
        "test/**/*.{ts,vibe}"
      ],
      "ignoreDependencies": [
        "@effect/platform-node-shared",
        "tailwindcss"
      ]
    },
    "packages/agent": {
      "entry": [
        "src/{index,bin}.vibe",
        "src/{client,voice,tasks}/index.vibe",
        "src/access/routes.vibe",
        "src/bundle/build.vibe",
        "test/**/*.test.{ts,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,vibe}",
        "test/**/*.{ts,vibe}"
      ]
    },
    "packages/os": {
      "entry": [
        "src/{index,cli}.vibe",
        "src/{image,build,browser,app-update}/index.vibe",
        "src/browser/address.ts",
        "src/bridges/*.vibe",
        "src/bridges/definitions/*.ts",
        "test/**/*.test.{ts,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,vibe}",
        "test/**/*.{ts,vibe}"
      ],
      "ignoreDependencies": [
        "@effect/platform-node-shared",
        "esbuild",
        "punycode",
        "tldts"
      ]
    },
    "apps/*": {
      "entry": [
        "test/**/*.test.{ts,tsx,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe,vibex,css}",
        "test/**/*.{ts,tsx,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "tailwindcss"
      ]
    }
  }
}
