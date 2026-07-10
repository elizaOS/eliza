/**
 * Per-account pool of discord.js `Client` and manager state
 * (`DiscordAccountClientState`), keyed by resolved account id, so multi-account
 * mode keeps one gateway client and its managers per token.
 */
import type { Client as DiscordJsClient } from "discord.js";
import {
	DEFAULT_ACCOUNT_ID,
	normalizeAccountId,
	type ResolvedDiscordAccount,
} from "./accounts";
import type { ChannelDebouncer } from "./debouncer";
import type { MessageManager } from "./messages";
import type { DiscordSettings } from "./types";
import type { VoiceManager } from "./voice";

export interface DiscordAccountClientState {
	accountId: string;
	account: ResolvedDiscordAccount;
	client: DiscordJsClient | null;
	settings: DiscordSettings;
	allowedChannelIds?: string[];
	listenChannelIds?: string[];
	dynamicChannelIds: Set<string>;
	clientReadyPromise: Promise<void> | null;
	loginFailed: boolean;
	// Pending initial-login retry, tracked so `stop()` can cancel an in-flight
	// backoff and the ClientReady handler can clear a superseded retry.
	loginRetryTimer?: ReturnType<typeof setTimeout>;
	// Wall-clock of the last login-failure heartbeat, used to throttle the Warn
	// heartbeat while the account is stuck retrying.
	lastLoginHeartbeatAt?: number;
	messageManager?: MessageManager;
	voiceManager?: VoiceManager;
	channelDebouncer?: ChannelDebouncer;
}

export class DiscordAccountClientPool {
	private defaultAccountId: string;
	private readonly clients = new Map<string, DiscordAccountClientState>();

	constructor(defaultAccountId = DEFAULT_ACCOUNT_ID) {
		this.defaultAccountId = normalizeAccountId(defaultAccountId);
	}

	setDefaultAccountId(accountId: string): void {
		this.defaultAccountId = normalizeAccountId(accountId);
	}

	getDefaultAccountId(): string {
		return this.defaultAccountId;
	}

	set(state: DiscordAccountClientState): void {
		const accountId = normalizeAccountId(state.accountId);
		state.accountId = accountId;
		this.clients.set(accountId, state);
	}

	get(accountId?: string | null): DiscordAccountClientState | null {
		const normalized = normalizeAccountId(accountId ?? this.defaultAccountId);
		return this.clients.get(normalized) ?? null;
	}

	getDefault(): DiscordAccountClientState | null {
		return this.get(this.defaultAccountId) ?? this.list()[0] ?? null;
	}

	list(): DiscordAccountClientState[] {
		return Array.from(this.clients.values());
	}

	listAccountIds(): string[] {
		return this.list().map((state) => state.accountId);
	}

	clear(): void {
		this.clients.clear();
	}
}
