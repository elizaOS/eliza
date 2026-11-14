// Knip reads .vibe files through VibeLang's own compiler, which gives it a module's imports and exports without bodies.
// Each exception below names something Knip cannot follow:
//   ignore vibestack/examples/**            standalone projects with their own install, outside the workspace
//   ignore **/test/fixtures/**              inputs the tools' tests read as text, never imported
//   ignoreIssues server.vibe exports        AGENTS is used in its own file, in a body ignoreExportsUsedInFile cannot see
//   root @informalsystems/quint, lemmascript  run as executables by vibestack/units.ts and vibestack/prove.ts
//   root @vitest/browser                    loaded by Vitest's browser mode, beside @vitest/browser-playwright
//   tailwindcss (ui, design-system, studio, apps)  resolved by @tailwindcss/vite and the lint plugin from CSS
//   entry *.schema, *.contract              imported by the tests vibestack/testing/generate.ts writes under .cache/
//   design-system eslint, eslint-plugin-better-tailwindcss, typescript-eslint  loaded by name in vibestack/design/test/design.test.ts
import vibelang from "vibelang/knip"

export default {
  compilers: { vibe: vibelang, vibex: vibelang },
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
        "@vitest/browser"
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
