/**
 * XR simulator route serves the built browser emulator bundle for Playwright
 * and local headset simulation harnesses.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Route } from "@elizaos/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "../../");
const EMULATOR_BUNDLE = resolve(pluginRoot, "../../emulator/dist/emulator.js");

export const simulatorRoute: Route = {
  type: "GET",
  path: "/xr/simulator.js",
  description:
    "Serves the XR device emulator bundle (IWER + camera injection) for Playwright testing. Build first: cd plugins/plugin-facewear/emulator && bun run build",
  routeHandler: async (_ctx) => {
    if (!existsSync(EMULATOR_BUNDLE)) {
      return {
        status: 404,
        body: {
          error: "Emulator bundle not built",
          hint: "Run: cd eliza/plugins/plugin-facewear/emulator && bun run build",
        },
      };
    }

    const js = readFileSync(EMULATOR_BUNDLE, "utf8");
    return {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
      body: js,
    };
  },
};
