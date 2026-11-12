import { spawnSync } from "node:child_process";

const result = spawnSync(
  "bun",
  [
    "test",
    "packages/cloud/api/src/speech-retirement-route.test.ts",
    "packages/cloud/api/src/speech-retirement-coordinator.test.ts",
    "packages/cloud/api/__tests__/voice-speech-mint.test.ts",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const consent = spawnSync(
  "bun",
  ["test", "packages/cloud/api/__tests__/voice-speech-rate-limit.pglite.test.ts"],
  { stdio: "inherit" },
);
if (consent.error) throw consent.error;
if (consent.status !== 0) process.exit(consent.status ?? 1);
