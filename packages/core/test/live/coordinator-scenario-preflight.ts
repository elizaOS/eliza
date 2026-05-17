import { runCoordinatorPreflight } from "@elizaos/agent";

try {
	const result = await runCoordinatorPreflight({
		baseUrl: process.env.ELIZA_BASE_URL,
	});
	console.log(
		JSON.stringify(
			{
				...result,
				channelSummary: result.channelReadiness.map((channel) => ({
					channel: channel.channel,
					available: channel.available,
					configured: channel.configured,
					configReady: channel.configReady,
					healthStatuses: channel.healthStatuses,
					reason: channel.reason,
				})),
			},
			null,
			2,
		),
	);
	process.exit(result.ok ? 0 : 1);
} catch (error) {
	console.error("[coordinator-scenario-preflight] FAIL");
	console.error(error);
	process.exit(1);
}
