/**
 * MESSAGE connector account resolution. A connector service registers a
 * legacy source-level route beside one route per account, so a single
 * account is two connectors aliasing the same source; only distinct accounts
 * are ambiguous.
 */
import { describe, expect, it } from "vitest";
import { selectConnectorForOp } from "./message";

type Connector = Parameters<typeof selectConnectorForOp>[0][number];

function connector(
	overrides: Partial<Connector> & Pick<Connector, "source" | "label">,
): Connector {
	return {
		capabilities: ["send_message"],
		supportedTargetKinds: [],
		contexts: [],
		...overrides,
	} as Connector;
}

describe("selectConnectorForOp", () => {
	const legacy = connector({ source: "discord", label: "Discord" });
	const scoped = connector({
		source: "discord",
		label: "Discord (default)",
		accountId: "default",
	});

	it("resolves a single account registered beside its legacy source route (live: read #general from the owner API)", () => {
		const selection = selectConnectorForOp(
			[legacy, scoped],
			"discord",
			"agent_message_api",
			"read_channel",
		);
		expect(selection).toMatchObject({
			connector: { source: "discord", accountId: "default" },
		});
	});

	it("still honours an explicit account", () => {
		expect(
			selectConnectorForOp(
				[legacy, scoped],
				"discord",
				undefined,
				"read_channel",
				"default",
			),
		).toMatchObject({ connector: { accountId: "default" } });
	});

	it("keeps two distinct accounts ambiguous without an account", () => {
		const team = connector({
			source: "discord",
			label: "Discord (team)",
			accountId: "team",
		});
		const selection = selectConnectorForOp(
			[legacy, scoped, team],
			"discord",
			undefined,
			"read_channel",
		);
		expect(selection).toMatchObject({
			error: { success: false, values: { error: "SOURCE_AMBIGUOUS" } },
		});
	});
});

it.each([false, true])(
	"retains ambiguity between distinct routes with scoped=%s",
	(scoped) => {
		const routes = ["first", "second"].map((label) =>
			connector({
				source: "discord",
				label,
				...(scoped ? { accountId: "same-account" } : {}),
			}),
		);
		expect(
			selectConnectorForOp(routes, "discord", undefined, "read_channel"),
		).toMatchObject({
			error: { success: false, values: { error: "SOURCE_AMBIGUOUS" } },
		});
	},
);
