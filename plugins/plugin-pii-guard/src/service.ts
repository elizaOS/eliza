/**
 * Runtime service that supplies the local NER recognizer to the core PII swap
 * layer. Registers under {@link PII_ENTITY_RECOGNIZER_SERVICE}; the runtime looks
 * this up when `ELIZA_PII_SWAP_ENABLED` is on and composes the returned
 * recognizer with its built-in regex recognizer.
 *
 * Boot is non-blocking: `start()` kicks off the model load in the background and
 * returns immediately, so a slow first download never stalls agent boot. Until
 * the model is ready `getRecognizer()` still returns the recognizer — its own
 * `recognize()` awaits readiness internally. If the load fails, `getRecognizer()`
 * returns `null` and the layer runs regex-only.
 */

import {
  type IAgentRuntime,
  logger,
  PII_ENTITY_RECOGNIZER_SERVICE,
  type PiiEntityRecognizer,
  type PiiEntityRecognizerService,
  Service,
  type ServiceTypeName,
} from "@elizaos/core";
import {
  DEFAULT_NER_MODEL,
  DEFAULT_SCORE_THRESHOLD,
  NerEntityRecognizer,
} from "./ner-recognizer.js";

export class PiiGuardService
  extends Service
  implements PiiEntityRecognizerService
{
  static override serviceType: ServiceTypeName =
    PII_ENTITY_RECOGNIZER_SERVICE as ServiceTypeName;

  override capabilityDescription =
    "Supplies a local distilbert-NER recognizer (person / org / location) to the runtime's PII pseudonymization layer.";

  private recognizer: NerEntityRecognizer | null = null;

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<PiiGuardService> {
    const service = new PiiGuardService(runtime);

    const configuredModel = runtime.getSetting("ELIZA_PII_NER_MODEL");
    const modelId =
      typeof configuredModel === "string" && configuredModel.length > 0
        ? configuredModel
        : DEFAULT_NER_MODEL;
    const scoreThreshold = parseThreshold(
      runtime.getSetting("ELIZA_PII_NER_SCORE_THRESHOLD"),
    );

    const recognizer = new NerEntityRecognizer({ modelId, scoreThreshold });
    service.recognizer = recognizer;

    // Kick off the model load in the background — do not block boot on it.
    void recognizer.load();
    logger.info(
      `[PiiGuard] service started; loading NER model ${modelId} in background`,
    );

    return service;
  }

  /**
   * The recognizer, or `null` if the model load has definitively failed. While
   * the model is still loading this returns the recognizer (its `recognize()`
   * awaits readiness), so callers never block boot but always get results once
   * the model is ready.
   */
  getRecognizer(): PiiEntityRecognizer | null {
    if (!this.recognizer || this.recognizer.hasFailed()) return null;
    return this.recognizer;
  }

  async stop(): Promise<void> {
    this.recognizer = null;
  }
}

/** Parse a configured threshold; ignore non-numeric / out-of-range values. */
function parseThreshold(raw: string | boolean | number | null): number {
  if (raw === null || raw === "" || typeof raw === "boolean") {
    return DEFAULT_SCORE_THRESHOLD;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    logger.warn(
      `[PiiGuard] ignoring invalid ELIZA_PII_NER_SCORE_THRESHOLD=${JSON.stringify(raw)}; using ${DEFAULT_SCORE_THRESHOLD}`,
    );
    return DEFAULT_SCORE_THRESHOLD;
  }
  return value;
}
