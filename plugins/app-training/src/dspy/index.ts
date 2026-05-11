/**
 * DSPy-style primitives (native TS).
 *
 * No `@ax-llm/ax`, `dspy`, or `ax` dependency — this is our own implementation
 * of Signature, Predict, ChainOfThought, plus the BootstrapFewshot / COPRO /
 * MIPROv2 optimizers and the eliza_native_v1-compatible artifact shape.
 */

export {
	type BuildArtifactOptions,
	buildDspyArtifact,
	type DspyArtifact,
	type DspyArtifactTask,
} from "./artifact.js";
export {
	ChainOfThought,
	type ChainOfThoughtResult,
} from "./chain-of-thought.js";
export {
	buildExamplesFromRows,
	type Example,
	type LoadExamplesOptions,
	type LoadExamplesResult,
	loadExamplesFromElizaV1,
} from "./examples.js";
export {
	CerebrasAdapter,
	type ChatMessage,
	type GenerateArgs,
	type GenerateResult,
	type LanguageModelAdapter,
	legacyAdapterToLm,
	MockAdapter,
	type MockAdapterOptions,
	type MockRule,
	type UsageInfo,
	type UseModelLike,
} from "./lm-adapter.js";
export * from "./optimizers/index.js";
export {
	Predict,
	type PredictOpts,
	type PredictResult,
	type PredictTrace,
	renderDemonstrationsBlock,
} from "./predict.js";
export {
	defineSignature,
	type FieldSpec,
	type FieldType,
	type RenderedPrompt,
	Signature,
	SignatureParseError,
	type SignatureSpec,
} from "./signature.js";
