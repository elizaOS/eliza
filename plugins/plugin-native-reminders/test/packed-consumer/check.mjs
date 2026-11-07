import { resolve } from "node:path";
import { verifyPackedConsumer } from "../../../../packages/scripts/lib/packed-consumer.ts";

verifyPackedConsumer({
  packageRoot: resolve(import.meta.dirname, "../.."),
  fixtureDirectory: import.meta.dirname,
  requiredFiles: [
    "dist/android.js",
    "dist/android.d.ts",
    "src/android.ts",
    "android/src/main/java/ai/eliza/plugins/reminders/ReminderPlugin.java",
  ],
  sourcePrefixes: [
    "android/build.gradle",
    "android/README.md",
    "android/src/main",
  ],
  dependencies: ["@capacitor/core"],
  compiler: process.env.REMINDERS_TSC || undefined,
});
