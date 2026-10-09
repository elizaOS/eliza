#!/usr/bin/env bun
/**
 * One-shot fixture generator. Writes the deterministic synthetic WAV
 * files into `plugins/plugin-local-inference/native/voice-bench/fixtures/`. The fixtures
 * dir is gitignored — regenerate before running the bench if you've
 * cleaned a checkout.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateAllFixtures,
  writeFixtureWav,
} from "../../../../../../plugins/plugin-local-inference/native/voice-bench/src/fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(
  here,
  "../../../../../../plugins/plugin-local-inference/native/voice-bench/fixtures",
);

const set = generateAllFixtures();
writeFixtureWav(join(fixturesDir, "silence.wav"), set.silence);
writeFixtureWav(join(fixturesDir, "short-utterance.wav"), set.short);
writeFixtureWav(join(fixturesDir, "long-utterance.wav"), set.long);
writeFixtureWav(join(fixturesDir, "false-eos-utterance.wav"), set.falseEos);
writeFixtureWav(join(fixturesDir, "barge-in-overlay.wav"), set.bargeInOverlay);

process.stdout.write(`[voice-bench] generated 5 fixtures in ${fixturesDir}\n`);
