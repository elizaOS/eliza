/**
 * `@elizaos/plugin-pii-guard` — supplies a local NER model recognizer to the
 * `@elizaos/core` PII pseudonymization layer.
 *
 * `@elizaos/core` never hard-depends on an ONNX runtime; it looks up the
 * {@link PII_ENTITY_RECOGNIZER_SERVICE} when PII swap is enabled
 * (`ELIZA_PII_SWAP_ENABLED`) and composes the recognizer this plugin provides
 * with its built-in regex recognizer. This plugin owns the heavy dependency
 * (`@huggingface/transformers` + `onnxruntime-node`) and the `dslim/distilbert-NER`
 * model (Apache-2.0), covering person / org / location. Email / phone / address
 * are handled elsewhere by core's regex recognizer.
 */

import type { Plugin } from "@elizaos/core";
import { PiiGuardService } from "./service.js";

export type {
  ClassifierFactory,
  NerRecognizerOptions,
  RawNerGroup,
  StitchedEntity,
  TokenClassifier,
} from "./ner-recognizer.js";
export {
  chunkText,
  DEFAULT_NER_MODEL,
  DEFAULT_SCORE_THRESHOLD,
  joinWordPieces,
  NerEntityRecognizer,
  normalizeGroupedWord,
  relocateEntities,
  stitchBioTokens,
} from "./ner-recognizer.js";
export { PiiGuardService } from "./service.js";

export const piiGuardPlugin: Plugin = {
  name: "pii-guard",
  description:
    "Local distilbert-NER recognizer (person / org / location) for the runtime's PII pseudonymization layer.",
  services: [PiiGuardService],
  async dispose(runtime) {
    const svc = runtime.getService<PiiGuardService>(
      PiiGuardService.serviceType,
    );
    await svc?.stop();
  },
};

export default piiGuardPlugin;
