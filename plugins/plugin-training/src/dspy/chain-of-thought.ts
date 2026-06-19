/**
 * DSPy-style ChainOfThought module (native TS).
 *
 * Wraps `Predict` and prepends a `reasoning: string` output field to the
 * signature so the model thinks step-by-step before emitting the original
 * outputs. The `reasoning` field is returned alongside `output` for
 * inspection but is NOT part of the typed output record returned to callers
 * who don't care about it.
 */

import type { UsageInfo } from "./lm-adapter.js";
import {
  Predict,
  type PredictOpts,
  type PredictResult,
  type PredictTrace,
} from "./predict.js";
import { type FieldSpec, Signature, type SignatureSpec } from "./signature.js";

export interface ChainOfThoughtResult<
  O extends Record<string, unknown> = Record<string, unknown>,
> {
  output: O;
  reasoning: string;
  usage: UsageInfo;
  trace: PredictTrace;
}

const REASONING_FIELD: FieldSpec = {
  name: "reasoning",
  description:
    "Step-by-step reasoning that leads to the answer. Be terse — list the salient facts and the deduction, not commentary.",
  type: "string",
};

export class ChainOfThought<
  I extends Record<string, unknown> = Record<string, unknown>,
  O extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly predict: Predict<I, O & { reasoning: string }>;

  constructor(opts: PredictOpts<I, O>) {
    const augmented = augmentSignatureWithReasoning(opts.signature.spec);
    this.predict = new Predict<I, O & { reasoning: string }>({
      ...opts,
      signature: new Signature<I, O & { reasoning: string }>(augmented),
    });
  }

  get signature(): Signature<I, O & { reasoning: string }> {
    return this.predict.signature;
  }

  async forward(input: I): Promise<ChainOfThoughtResult<O>> {
    const result: PredictResult<O & { reasoning: string }> =
      await this.predict.forward(input);
    const { reasoning, ...rest } = result.output;
    // `rest` has type `Omit<O & { reasoning: string }, "reasoning">`, which
    // is structurally equal to `O` (we only added `reasoning` ourselves and
    // just removed it). TS cannot prove this through Omit-on-intersection,
    // so the double-cast is the minimal type assertion to bridge the
    // destructure to O.
    return {
      output: rest as unknown as O,
      reasoning: typeof reasoning === "string" ? reasoning : "",
      usage: result.usage,
      trace: result.trace,
    };
  }
}

function augmentSignatureWithReasoning(spec: SignatureSpec): SignatureSpec {
  // Reasoning is the first output field — DSPy's convention. The renderer
  // then asks the model to print `reasoning:` before any other field, which
  // is the literal "think then answer" effect.
  const outputs: FieldSpec[] = [REASONING_FIELD, ...spec.outputs];
  return {
    ...spec,
    outputs,
  };
}
