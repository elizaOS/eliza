/**
 * Runtime service that injects the local-LLM PII recognizer behind core's
 * `PII_ENTITY_RECOGNIZER_SERVICE` seam. The runtime looks this service up when
 * `ELIZA_PII_SWAP_ENABLED` is on and composes the recognizer with its built-in
 * regex recognizer.
 *
 * `getRecognizer()` returns `null` while no local backend exposes `generate`
 * (no Eliza-1 bundle activated yet) — the PII layer then runs regex-only, which
 * is the seam's designed degrade. Once a backend is active the recognizer runs
 * extraction prompts against it through the process-wide inference priority
 * gate, so PII passes share the single resident model without corrupting an
 * in-flight decode. PII never leaves the device: the generate closure resolves
 * the local backend service directly and never touches `runtime.useModel`.
 */

import {
	getInferencePriorityGate,
	type IAgentRuntime,
	logger,
	PII_ENTITY_RECOGNIZER_SERVICE,
	type PiiEntityRecognizer,
	type PiiEntityRecognizerService,
	Service,
	type ServiceTypeName,
} from "@elizaos/core";
import { LlmEntityRecognizer } from "./llm-recognizer.js";

/** The same service names provider.ts probes for the active local backend. */
const BACKEND_SERVICE_NAMES = [
	"localInferenceLoader",
	"localInference",
	"LOCAL_INFERENCE",
] as const;

interface GenerateCapableBackend {
	generate: (args: {
		prompt: string;
		maxTokens?: number;
		temperature?: number;
		stopSequences?: string[];
	}) => Promise<string>;
}

function activeBackend(runtime: IAgentRuntime): GenerateCapableBackend | null {
	const withServices = runtime as IAgentRuntime & {
		getService?: (name: string) => unknown;
	};
	if (typeof withServices.getService !== "function") return null;
	for (const name of BACKEND_SERVICE_NAMES) {
		const candidate: unknown = withServices.getService(name);
		if (
			candidate &&
			typeof candidate === "object" &&
			typeof (candidate as { generate?: unknown }).generate === "function"
		) {
			return candidate as GenerateCapableBackend;
		}
	}
	return null;
}

export class LocalPiiRecognizerService
	extends Service
	implements PiiEntityRecognizerService
{
	static override serviceType: ServiceTypeName =
		PII_ENTITY_RECOGNIZER_SERVICE as ServiceTypeName;

	override capabilityDescription =
		"Supplies a local-LLM named-entity recognizer (person / org / location) to the runtime's PII pseudonymization layer, running on the resident Eliza-1 backend.";

	private recognizer: LlmEntityRecognizer | null = null;

	static override async start(
		runtime: IAgentRuntime,
	): Promise<LocalPiiRecognizerService> {
		const service = new LocalPiiRecognizerService(runtime);
		service.recognizer = new LlmEntityRecognizer(async (args) => {
			const backend = activeBackend(runtime);
			if (!backend) {
				throw new Error(
					"[LocalPii] no active local inference backend; PII layer degrades to regex-only",
				);
			}
			return getInferencePriorityGate().runExclusive(
				{
					priority: "interactive",
					label: `pii-ner local-service (${args.prompt.length} chars)`,
				},
				() => backend.generate(args),
			);
		});
		logger.info(
			"[LocalPii] PII entity recognizer service registered (local-LLM NER over the resident backend)",
		);
		return service;
	}

	/** `null` while no local backend can generate — the layer runs regex-only. */
	getRecognizer(): PiiEntityRecognizer | null {
		if (!this.recognizer || !activeBackend(this.runtime)) return null;
		return this.recognizer;
	}

	async stop(): Promise<void> {
		this.recognizer = null;
	}
}
