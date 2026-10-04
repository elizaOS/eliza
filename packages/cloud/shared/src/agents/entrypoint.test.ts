import { expect, test } from "bun:test";

/** Guard the actual transitive graph, including dynamic imports from queue helpers. */
test("Worker agent admission cannot load Node provisioning or sandbox providers", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./index.ts", import.meta.url).pathname],
    target: "browser",
    packages: "external",
    external: ["node:*"],
    plugins: [
      {
        name: "worker-agent-boundary",
        setup(builder) {
          builder.onLoad(
            {
              filter:
                /(?:\/shared\/src\/node\/|\/(?:docker|local-docker|memory)-sandbox-provider\.ts$)/,
            },
            ({ path }) => {
              throw new Error(`Worker admission imported Node execution: ${path}`);
            },
          );
        },
      },
    ],
  });
  expect(build.logs.filter((entry) => entry.level === "error")).toEqual([]);
  expect(build.success).toBe(true);
});
