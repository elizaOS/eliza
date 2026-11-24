// Knip reads .vibe files through VibeLang's own compiler, which gives it a module's imports and exports without bodies.
// Each exception below names something Knip cannot follow:
//   ignore vibestack/examples/**            standalone projects with their own install, outside the workspace
//   ignore **/test/fixtures/**              inputs the tools' tests read as text, never imported
//   ignoreIssues server.vibe exports        AGENTS is used in its own file, in a body ignoreExportsUsedInFile cannot see
//   ignoreIssues sse.ts, relay-frames.ts exports  verified //@ modules whose laws and helpers the proof stage reads, not another module
//   ignoreIssues assistant host.vibe exports  RecordUnreadable is thrown only in its own file, yet the declarations of the exported reads must name it
//   root lemmascript                       run as an executable by vibestack/prove.ts
//   root @vitest/browser                    loaded by Vitest's browser mode, beside @vitest/browser-playwright
//   root @repo/design-system                read as files by vibestack/design/test/design.test.ts
//   tailwindcss (ui, design-system, studio, cloud)  resolved by @tailwindcss/vite and the lint plugin from CSS
//   core @biomejs/biome                     resolved by path in src/catalog/generate.vibe
//   os ruby, otool                           system binaries used by the Android toolchain
//   entry *.meta.tsx, *.css (ui, cloud)     read by the design tool and the page's index.html
//   entry *.schema, *.contract              imported by the tests vibestack/testing/generate.ts writes under .cache/
//   design-system eslint, eslint-plugin-better-tailwindcss, typescript-eslint  loaded by name in vibestack/design/test/design.test.ts
//   browser surface read-page.js           bundled and loaded by the native iOS host
//   plugin root duplicate exports          named and default entry points for the same factory
//   network @mockoon/cli                   spawned in the VibeLang relay test
//   trajectory logger react, @types/react  automatic JSX runtime and types of the exported ./ui
import vibelang from "vibelang/knip"

export default {
  compilers: { vibe: vibelang, vibex: vibelang },
  "ignore": [
    "vibestack/examples/**",
    "**/test/fixtures/**"
  ],
  "ignoreExportsUsedInFile": true,
  "ignoreIssues": {
    "vibestack/studio/src/server.vibe": ["exports"],
    "packages/cloud/src/services/sse.ts": ["exports"],
    "packages/cloud/src/client/relay-frames.ts": ["exports"],
    "packages/plugin-assistant/src/host.vibe": ["exports"],
    "packages/agent/test/support/product-plugin/entry.ts": ["unlisted"],
    "packages/plugin-native-browser-surface/resources/read-page.js": ["files"],
    "packages/plugin-anthropic/src/index.vibe": ["duplicates"],
    "packages/plugin-discord/src/index.vibe": ["duplicates"],
    "packages/plugin-elizacloud/src/index.vibe": ["duplicates"],
    "packages/plugin-embeddings/src/index.vibe": ["duplicates"],
    "packages/plugin-github/src/index.vibe": ["duplicates"],
    "packages/plugin-imessage/src/index.vibe": ["duplicates"],
    "packages/plugin-openai/src/index.vibe": ["duplicates"],
    "packages/plugin-pdf/src/index.vibe": ["duplicates"],
    "packages/plugin-slack/src/index.vibe": ["duplicates"],
    "packages/plugin-telegram/src/index.vibe": ["duplicates"],
    "packages/plugin-video/src/index.vibe": ["duplicates"],
    "packages/plugin-vision/src/index.vibe": ["duplicates"],
    "packages/plugin-wallet/src/index.vibe": ["duplicates"],
    "packages/plugin-web-search/src/index.vibe": ["duplicates"],
    "packages/plugin-x/src/index.vibe": ["duplicates"],
    "packages/plugin-assistant/src/index.vibe": ["duplicates"],
    "packages/plugin-browser/src/index.vibe": ["duplicates"],
    "packages/plugin-calendar/src/index.vibe": ["duplicates"],
    "packages/plugin-files/src/index.vibe": ["duplicates"],
    "packages/plugin-inbox/src/index.vibe": ["duplicates"],
    "packages/plugin-maps/src/index.vibe": ["duplicates"],
    "packages/plugin-workflows/src/index.vibe": ["duplicates"]
  },
  "workspaces": {
    ".": {
      "entry": [
        "vibestack/design/cli.ts",
        "vibestack/stories/cli.ts",
        "vibestack/remote-cache.ts",
        "vibestack/chromium.ts",
        "vibestack/*/test/*.test.ts",
        "vibestack/testing/test/fixture/*/src/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "vibestack/**/*.{ts,tsx,vibe,vibex}",
        "!vibestack/studio/**"
      ],
      "ignoreDependencies": [
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
        "src/**/*.{ts,vibe,vibex}",
        "test/**/*.{ts,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "@effect/platform-node-shared",
        "@biomejs/biome"
      ]
    },
    "packages/cloud": {
      "entry": [
        "src/{index,main}.vibe",
        "src/pages/render.tsx",
        "src/pages/*.{meta.tsx,css}",
        "test/**/*.test.{ts,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe,vibex,css}",
        "test/**/*.{ts,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "@effect/platform-node-shared",
        "tailwindcss"
      ]
    },
    "packages/agent": {
      "vitest": { "config": [] },
      "entry": [
        "vitest.config.ts",
        "src/{index,bin}.vibe",
        "src/{client,voice,tasks}/index.vibe",
        "test/**/*.test.{ts,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,vibe,vibex}",
        "test/**/*.{ts,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "@effect/platform-node-shared"
      ]
    },
    "packages/plugin-assistant": {
      "entry": ["src/**/*.{schema,contract}.{ts,vibe}"]
    },
    "packages/plugin-calendar": {
      "entry": ["src/**/*.{schema,contract}.{ts,vibe}"]
    },
    "packages/plugin-inbox": {
      "entry": ["src/**/*.{schema,contract}.{ts,vibe}"]
    },
    "packages/plugin-maps": {
      "entry": ["src/**/*.{schema,contract}.{ts,vibe}"]
    },
    "packages/plugin-network": {
      "ignoreDependencies": ["@mockoon/cli"]
    },
    "packages/plugin-notes": {
      "entry": ["src/**/*.{schema,contract}.{ts,vibe}"]
    },
    "packages/plugin-trajectory-logger": {
      "ignoreDependencies": ["react", "@types/react"]
    },
    "packages/plugin-workflows": {
      "entry": ["src/worker/main.vibe", "src/**/*.{schema,contract}.{ts,vibe}"]
    },
    "packages/os": {
      "entry": [
        "src/{index,cli}.vibe",
        "src/{image,build,browser,app-update}/index.vibe",
        "src/bridges/*.vibe",
        "src/bridges/definitions/*.ts",
        "test/**/*.test.{ts,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,vibe,vibex}",
        "test/**/*.{ts,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "@effect/platform-node-shared"
      ],
      "ignoreBinaries": [
        "ruby",
        "otool"
      ],
      "ignoreUnresolved": [
        "./runtime-config.mjs"
      ]
    }
  }
}
