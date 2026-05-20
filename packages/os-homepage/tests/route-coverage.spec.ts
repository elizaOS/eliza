import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARDWARE_PRODUCTS } from "@elizaos/shared/hardware-catalog";
import { expect, test } from "playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_ROUTES_SPEC = path.join(HERE, "live-routes.spec.ts");
const VISUAL_SPEC = path.join(HERE, "visual.spec.ts");

function routePathsFromSpec(filePath: string): Set<string> {
  const source = readFileSync(filePath, "utf8");
  return new Set(
    [...source.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
}

test("elizaOS route matrices cover every product and checkout route", () => {
  const expectedRoutes = [
    "/",
    ...HARDWARE_PRODUCTS.map((product) => `/hardware/${product.slug}`),
    "/checkout",
    "/checkout/success",
    "/checkout/cancel",
  ];
  const liveRoutes = routePathsFromSpec(LIVE_ROUTES_SPEC);
  const visualRoutes = routePathsFromSpec(VISUAL_SPEC);

  const missingLiveRoutes = expectedRoutes.filter(
    (route) => !liveRoutes.has(route),
  );
  const missingVisualRoutes = expectedRoutes.filter(
    (route) => !visualRoutes.has(route),
  );

  expect(
    missingLiveRoutes,
    `Missing elizaOS live route coverage for: ${missingLiveRoutes.join(", ")}`,
  ).toEqual([]);
  expect(
    missingVisualRoutes,
    `Missing elizaOS visual route coverage for: ${missingVisualRoutes.join(", ")}`,
  ).toEqual([]);
});
