const fileRemote = {
  id: "eliza.fs",
  name: "Eliza File",
  version: "0.1.0",
  description:
    "File Remote for ElizaLaunch. Provides scoped filesystem capability operations for Eliza Orbit.",
  mode: "background",
  permissions: {
    bun: {
      read: true,
      write: true,
      env: true,
    },
    isolation: "isolated-process",
  },
  view: {
    relativePath: "src/web/index.html",
    title: "Eliza File Remote",
    width: 480,
    height: 320,
    hidden: true,
  },
  worker: {
    relativePath: "src/bun/worker.ts",
  },
} as const;

export default {
  app: {
    name: "Eliza File Remote",
    identifier: "ai.eliza.launch.fs",
    version: "0.1.0",
  },
  build: {
    carrot: fileRemote,
    carrotOnly: true,
  },
};
