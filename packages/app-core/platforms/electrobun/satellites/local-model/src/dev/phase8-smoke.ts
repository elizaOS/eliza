import { serializeError } from "../bun/errors.ts";
import { ModelSatelliteService } from "../bun/model-service.ts";

process.env.ELIZA_MODEL_HF_DISABLE_NETWORK ??= "1";

const REQUIRED_TIERS = [
	"0_6b",
	"0_8b",
	"1_7b",
	"2b",
	"4b",
	"9b",
	"27b",
	"27b-256k",
];

const REQUIRED_VOICE = ["omnivoice", "emotion", "turn", "asr", "kokoro"];

async function main(): Promise<void> {
	const service = new ModelSatelliteService();
	const catalog = await service.eliza1Catalog();
	const tiers = await service.eliza1Tiers();
	const voice = await service.eliza1Voice();
	const hub = await service.hub();

	assert(
		catalog.some((entry) => entry.hfRepo === "elizaos/eliza-1"),
		"Eliza-1 catalog must use elizaos/eliza-1.",
	);
	for (const tier of REQUIRED_TIERS) {
		assert(
			tiers.some((entry) => entry.tier === tier),
			`Missing Eliza-1 tier ${tier}.`,
		);
	}
	for (const component of REQUIRED_VOICE) {
		assert(
			voice.some((entry) => entry.id === component),
			`Missing Eliza-1 voice component ${component}.`,
		);
	}
	assert(Array.isArray(hub.catalog), "Hub catalog must be an array.");
	assert(Array.isArray(hub.eliza1Tiers), "Hub tiers must be an array.");
	assert(Array.isArray(hub.voiceComponents), "Hub voice components must be an array.");
	assert(Array.isArray(hub.installed), "Hub installed models must be an array.");
	assert(Array.isArray(hub.downloads), "Hub downloads must be an array.");
	assert(hub.active.status.length > 0, "Hub active status must be structured.");

	const unavailable = await expectUnavailable(() => service.providers());
	assert(
		unavailable.code === "MODEL_LOCAL_INFERENCE_UNAVAILABLE" ||
			unavailable.code === "MODEL_ROUTE_UNAVAILABLE",
		"Missing local inference API must return a structured unavailable error.",
	);

	let hfMetadata: unknown = null;
	if (process.env.ELIZA_PHASE8_HF_NETWORK === "1") {
		process.env.ELIZA_MODEL_HF_DISABLE_NETWORK = "0";
		hfMetadata = await service.hfMetadata();
	}

	let liveApi: unknown = null;
	if (process.env.ELIZA_PHASE8_LIVE_API === "1") {
		liveApi = {
			status: await service.status(),
			providers: await service.providers(),
			active: await service.active(),
		};
	}

	writeJson({
		ok: true,
		catalogCount: catalog.length,
		tiers: tiers.map((entry) => entry.tier),
		voice: voice.map((entry) => entry.id),
		hub: {
			catalogCount: hub.catalog.length,
			installedCount: hub.installed.length,
			active: hub.active,
			downloadCount: hub.downloads.length,
		},
		missingApiError: unavailable,
		hfMetadata,
		liveApi,
	});
}

async function expectUnavailable(
	action: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
	try {
		await action();
		throw new Error("Expected action to fail.");
	} catch (error) {
		const serialized = serializeError(error);
		return {
			code: serialized.code,
			message: serialized.message,
		};
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

await main();
