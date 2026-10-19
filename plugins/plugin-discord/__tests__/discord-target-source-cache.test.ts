import { describe, expect, it } from "vitest";
import {
	createDiscordSourceCache,
	fetchDiscordEnumeration,
} from "../discord-target-source";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Routes the two REST endpoints the enumerator calls, in call order. */
function makeFetch(script: Array<"fail-guilds" | "guilds" | "channels">) {
	const calls: string[] = [];
	const fetchImpl = (async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const step = script.shift();
		if (url.endsWith("/users/@me/guilds")) {
			if (step === "fail-guilds") {
				return new Response("upstream unavailable", { status: 503 });
			}
			return jsonResponse([{ id: "g1", name: "Guild One" }]);
		}
		if (url.endsWith("/guilds/g1/channels")) {
			return jsonResponse([{ id: "c1", name: "general", type: 0 }]);
		}
		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

describe("fetchDiscordEnumeration cache", () => {
	it("does not serve a failed guild list from cache", async () => {
		const cache = createDiscordSourceCache();
		const warn = () => {};
		const failed = makeFetch(["fail-guilds"]);
		const failedResult = await fetchDiscordEnumeration("token", {
			fetchImpl: failed.fetchImpl,
			cache,
			now: () => 1_000,
			logger: { warn },
		});
		expect(failedResult).toEqual([]);

		// Discord recovers one second later, well inside the five minute window.
		const recovered = makeFetch(["guilds", "channels"]);
		const result = await fetchDiscordEnumeration("token", {
			fetchImpl: recovered.fetchImpl,
			cache,
			now: () => 2_000,
			logger: { warn },
		});

		expect(result).toEqual([
			{
				guildId: "g1",
				guildName: "Guild One",
				channels: [{ id: "c1", name: "general" }],
			},
		]);
		expect(recovered.calls).toHaveLength(2);
	});

	it("still reuses a successful enumeration for the whole window", async () => {
		const cache = createDiscordSourceCache();
		const ok = makeFetch(["guilds", "channels", "guilds", "channels"]);
		const options = {
			fetchImpl: ok.fetchImpl,
			cache,
			now: () => 1_000,
			logger: { warn: () => {} },
		};
		await fetchDiscordEnumeration("token", options);
		await fetchDiscordEnumeration("token", options);
		expect(ok.calls).toHaveLength(2);
	});
});
