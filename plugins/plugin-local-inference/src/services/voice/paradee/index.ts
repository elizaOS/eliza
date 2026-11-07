/**
 * Public barrel for the desktop Paradee-8M v1.1 TTS path (host worker on
 * libelizainference). The engine and tests import from `./paradee`.
 */

export {
	decodeWorkerWav,
	HostTtsClient,
	type HostTtsClientOptions,
	hostTtsWorkerArgs,
	PARADEE_WORKER_MAX_TEXT_CHARS,
	ParadeeSpeechCancelledError,
} from "./host-tts-client";
export {
	createParadeeSpeakerPreset,
	createParadeeTtsBackend,
	PARADEE_MAX_REQUEST_CHARS,
	type ParadeeSynthesizer,
	ParadeeTtsBackend,
	type ParadeeTtsBackendOptions,
	splitParadeeText,
	wavToFloat32,
} from "./paradee-backend";
export {
	discoverParadeeEngine,
	PARADEE_MODEL_FILES,
	PARADEE_SAMPLE_RATE,
	PARADEE_VOICE_ID,
	type ParadeeDiscovery,
	type ParadeeEngineConfig,
	paradeeModelDirCandidates,
	resolveParadeeEngineConfig,
} from "./paradee-engine-discovery";
