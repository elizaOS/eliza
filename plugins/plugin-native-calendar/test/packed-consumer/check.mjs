import { resolve } from "node:path";
import { verifyPackedConsumer } from "../../../../packages/scripts/lib/packed-consumer.ts";

verifyPackedConsumer({
  packageRoot: resolve(import.meta.dirname, "../.."),
  fixtureDirectory: import.meta.dirname,
  requiredFiles: [
    "dist/esm/android.js",
    "dist/esm/android.d.ts",
    "dist/plugin.cjs.js",
    "dist/esm/index.js",
    "android/build.gradle",
  ],
  sourcePrefixes: ["android"],
  dependencies: ["@capacitor/core"],
});
