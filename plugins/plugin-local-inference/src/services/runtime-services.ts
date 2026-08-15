/**
 * Runtime-owned service adapters for local inference loaders and timed ASR.
 * Registration remains separate from startup so callers may register during
 * initialization without waiting on the runtime's initialization barrier.
 */

import { createService, type IAgentRuntime, Service } from "@elizaos/core";
import type {
	LocalInferenceLoadArgs,
	LocalInferenceLoader,
} from "./active-model";
import { localInferenceEngine } from "./engine";
import { decodeMonoPcm16Wav } from "./voice";

export const LOCAL_INFERENCE_LOADER_SERVICE_TYPE = "localInferenceLoader";
export const TIMED_ASR_SERVICE_TYPE = "timedAsr";

export type RuntimeServiceRegistrar = Pick<IAgentRuntime, "registerService">;

type Generate = NonNullable<LocalInferenceLoader["generate"]>;
type Embed = NonNullable<LocalInferenceLoader["embed"]>;

export interface RuntimeLocalInferenceLoader extends LocalInferenceLoader {
	getMemoryArbiter?: () => unknown;
	transcribe?: (args: {
		pcmBase64: string;
		sampleRate: number;
	}) => Promise<string>;
	describeImage?: (args: {
		imageBase64: string;
		mmprojPath?: string;
		prompt?: string;
	}) => Promise<string>;
}

/** Service instance that delegates the runtime lifecycle to one selected backend. */
export class LocalInferenceLoaderRuntimeService
	extends Service
	implements LocalInferenceLoader
{
	override capabilityDescription =
		"Owns the selected local-inference loader for this agent runtime.";

	readonly generate?: Generate;
	readonly embed?: Embed;
	readonly getMemoryArbiter?: () => unknown;
	readonly transcribe?: RuntimeLocalInferenceLoader["transcribe"];
	readonly describeImage?: RuntimeLocalInferenceLoader["describeImage"];

	constructor(
		runtime: IAgentRuntime,
		private readonly loader: RuntimeLocalInferenceLoader,
		private readonly stopLoader: () => Promise<void>,
	) {
		super(runtime);
		if (loader.generate) this.generate = loader.generate.bind(loader);
		if (loader.embed) this.embed = loader.embed.bind(loader);
		if (loader.getMemoryArbiter) {
			this.getMemoryArbiter = loader.getMemoryArbiter.bind(loader);
		}
		if (loader.transcribe) this.transcribe = loader.transcribe.bind(loader);
		if (loader.describeImage) {
			this.describeImage = loader.describeImage.bind(loader);
		}
	}

	async loadModel(args: LocalInferenceLoadArgs): Promise<void> {
		await this.loader.loadModel(args);
	}

	async unloadModel(): Promise<void> {
		await this.loader.unloadModel();
	}

	currentModelPath(): string | null {
		return this.loader.currentModelPath();
	}

	override async stop(): Promise<void> {
		await this.stopLoader();
	}
}

/**
 * Register a loader class without starting it. A post-initialize caller that
 * needs the instance immediately must await `getServiceLoadPromise()`.
 */
export async function registerLocalInferenceLoaderService(
	runtime: RuntimeServiceRegistrar,
	loader: RuntimeLocalInferenceLoader,
	options: { stop?: () => Promise<void> } = {},
): Promise<void> {
	const stopLoader = options.stop ?? (() => loader.unloadModel());
	const serviceClass = createService<LocalInferenceLoaderRuntimeService>(
		LOCAL_INFERENCE_LOADER_SERVICE_TYPE,
	)
		.withDescription(
			"Owns the selected local-inference loader for this agent runtime.",
		)
		.withStart(
			async (serviceRuntime) =>
				new LocalInferenceLoaderRuntimeService(
					serviceRuntime,
					loader,
					stopLoader,
				),
		)
		.build();
	await runtime.registerService(serviceClass);
}

/** Additive word-timed ASR surface consumed by meeting transcription. */
export class TimedAsrService extends Service {
	static override serviceType = TIMED_ASR_SERVICE_TYPE;
	override capabilityDescription =
		"Exposes fused word-timed ASR without widening the transcription model contract.";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<TimedAsrService> {
		return new TimedAsrService(runtime);
	}

	isAvailable(): boolean {
		return localInferenceEngine.voice() !== null;
	}

	async transcribeWav(
		wav: Uint8Array,
		signal?: AbortSignal,
	): Promise<
		Awaited<ReturnType<typeof localInferenceEngine.transcribePcmTimed>>
	> {
		const audio = decodeMonoPcm16Wav(wav);
		return localInferenceEngine.transcribePcmTimed(audio, signal);
	}

	override stop(): Promise<void> {
		return Promise.resolve();
	}
}

/** Register timed ASR without crossing the runtime initialization barrier. */
export async function registerTimedAsrService(
	runtime: RuntimeServiceRegistrar,
): Promise<void> {
	await runtime.registerService(TimedAsrService);
}
