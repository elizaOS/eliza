// spec/core/canonicalJson.md, "Story: Hash the same snapshot safely and deterministically"
import { Schema } from "effect";
import { contract } from "vibestack/testing";
import { AGENT_BACKUP_CANONICAL_JSON, canonicalJsonString } from "./canonical-json.vibe";
import { reversedKeys } from "./utils/deterministic.contract.ts";

const canonical = (value: Schema.Json) => canonicalJsonString(value, AGENT_BACKUP_CANONICAL_JSON);

export const snapshotsHashTheSameInAnyKeyOrder = contract({
  input: Schema.Json,
  run: canonical,
  deterministic: true,
  invariant: (value, text) => canonical(reversedKeys(value)) === text,
});
