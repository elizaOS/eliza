/**
 * Covers DiscordService's dynamic channel-allowlist trio
 * (isChannelAllowed/addAllowedChannel/removeAllowedChannel/getAllowedChannels)
 * for the default (no accountId) instance-field path — real logic, no Discord
 * gateway. Built the same way as slash-command-registration-scope.test.ts:
 * `Object.create(DiscordService.prototype)` plus the private fields the
 * methods read directly, since `accountPool` resolves to nothing for an
 * unconfigured account and the methods fall back to the instance fields.
 */
import { describe, expect, it } from "vitest";
import { DiscordAccountClientPool } from "../account-client-pool";
import { DiscordService } from "../service";

function makeService(overrides: Record<string, unknown> = {}) {
	return Object.assign(Object.create(DiscordService.prototype), {
		// getAccountState() always consults the (empty here) account pool first
		// and falls back to these instance fields when no account is configured
		// under "default" — the pool must be real, not undefined, for that
		// fallback branch to run instead of throwing on `.get()`.
		accountPool: new DiscordAccountClientPool(),
		defaultAccountId: "default",
		allowedChannelIds: undefined,
		dynamicChannelIds: new Set<string>(),
		client: null,
		...overrides,
	}) as DiscordService;
}

describe("DiscordService channel allowlist", () => {
	it("allows any channel when no allowlist is configured", () => {
		const service = makeService();
		expect(service.isChannelAllowed("any-channel")).toBe(true);
	});

	it("denies a channel outside both the static and dynamic allowlists", () => {
		const service = makeService({ allowedChannelIds: ["chan-a"] });
		expect(service.isChannelAllowed("chan-b")).toBe(false);
	});

	it("allows a channel present in the static allowlist", () => {
		const service = makeService({ allowedChannelIds: ["chan-a"] });
		expect(service.isChannelAllowed("chan-a")).toBe(true);
	});

	it("allows a channel added dynamically even when not in the static list", () => {
		const service = makeService({
			allowedChannelIds: ["chan-a"],
			dynamicChannelIds: new Set(["chan-b"]),
		});
		expect(service.isChannelAllowed("chan-b")).toBe(true);
	});

	it("refuses to add a channel the client doesn't have cached", () => {
		const service = makeService({
			client: { channels: { cache: new Map() } },
		});
		expect(service.addAllowedChannel("unknown-channel")).toBe(false);
	});

	it("adds a cached channel to the dynamic allowlist", () => {
		const dynamicChannelIds = new Set<string>();
		const service = makeService({
			dynamicChannelIds,
			client: { channels: { cache: new Map([["chan-c", {}]]) } },
		});
		expect(service.addAllowedChannel("chan-c")).toBe(true);
		expect(dynamicChannelIds.has("chan-c")).toBe(true);
	});

	it("refuses to remove a channel that's in the static allowlist", () => {
		const service = makeService({
			allowedChannelIds: ["chan-a"],
			dynamicChannelIds: new Set(["chan-a"]),
		});
		expect(service.removeAllowedChannel("chan-a")).toBe(false);
	});

	it("removes a dynamically added channel", () => {
		const dynamicChannelIds = new Set(["chan-b"]);
		const service = makeService({ dynamicChannelIds });
		expect(service.removeAllowedChannel("chan-b")).toBe(true);
		expect(dynamicChannelIds.has("chan-b")).toBe(false);
	});

	it("lists the union of static and dynamic channels with no duplicates", () => {
		const service = makeService({
			allowedChannelIds: ["chan-a", "chan-b"],
			dynamicChannelIds: new Set(["chan-b", "chan-c"]),
		});
		expect(service.getAllowedChannels().sort()).toEqual([
			"chan-a",
			"chan-b",
			"chan-c",
		]);
	});
});
