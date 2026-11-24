// A project's `.storybook/main.ts` is `export default defineMain(import.meta.dirname)`. Storybook and Vite are
// the project's own: this file names them as strings and hands Vite a plain object, so the tool installs neither.
import { dirname, relative, resolve } from "node:path";
import { type Options, generator, listener, outOf } from "./emit.ts";

interface Watcher { on(event: string, listener: (file: string) => void): unknown }

/**
 * Storybook's main config for the project whose `.storybook` directory is `dir`: the generated stories and the
 * hand-written ones, regenerated as components change. The project is never the working directory, which
 * belongs to whatever loads the config.
 */
export function defineMain(dir: string, options: Omit<Options, "root"> = {}) {
  const root = dirname(dir);
  const generate = generator({ ...options, root });
  const run = () => {
    for (const line of generate().diagnostics) console.warn(`stories: ${line}`);
  };
  // Storybook lists stories before Vite starts, so they are written now.
  run();
  return {
    framework: "@storybook/react-vite",
    stories: [`${relative(dir, resolve(root, options.out ?? outOf(root))).replaceAll("\\", "/")}/*.stories.tsx`, "../src/**/*.stories.@(ts|tsx)"],
    addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
    core: { disableTelemetry: true },
    viteFinal: <Config extends { plugins?: unknown[] }>(config: Config) => ({
      ...config,
      plugins: [
        ...(config.plugins ?? []),
        {
          name: "vibestack-stories",
          configureServer(server: { watcher: Watcher }) {
            const changed = listener(root, options.out, run);
            for (const event of ["add", "change", "unlink"]) server.watcher.on(event, changed);
          },
        },
      ],
    }),
  };
}
