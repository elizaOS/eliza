import {
	type IAgentRuntime,
	logger,
	setTrajectoryPurpose,
	withStandaloneTrajectory,
} from "@elizaos/core";
import type { BlueSkyClient } from "../client";
import type {
	BlueSkyConfig,
	BlueSkyCreatePostEventPayload,
	BlueSkyNotification,
	BlueSkyNotificationEventPayload,
	NotificationReason,
} from "../types";
import {
	DEFAULT_BLUESKY_ACCOUNT_ID,
	getActionInterval,
	getMaxActionsProcessing,
	getPollInterval,
	getPostIntervalRange,
	isPostingEnabled,
	normalizeBlueSkyAccountId,
	shouldPostImmediately,
} from "../utils/config";

function cursorCacheKey(agentId: string, accountId: string): string {
	return `bluesky:cursor:${agentId}:${accountId}`;
}

export class BlueSkyAgentManager {
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private actionTimer: ReturnType<typeof setInterval> | null = null;
	private postTimer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private lastSeenAt: string | null = null;
	public readonly accountId: string;

	constructor(
		public readonly runtime: IAgentRuntime,
		public readonly config: BlueSkyConfig & { accountId?: string },
		public readonly client: BlueSkyClient,
	) {
		this.accountId = normalizeBlueSkyAccountId(
			config.accountId ?? DEFAULT_BLUESKY_ACCOUNT_ID,
		);
	}

	getAccountId(): string {
		return this.accountId;
	}

	async start(): Promise<void> {
		if (this.running) return;

		await this.client.authenticate();
		this.running = true;

		const cached = await this.runtime.getCache<string>(
			cursorCacheKey(this.runtime.agentId, this.accountId),
		);
		if (typeof cached === "string" && cached) {
			this.lastSeenAt = cached;
		}

		this.startNotificationPolling();

		if (this.config.enableActionProcessing) {
			this.startActionProcessing();
		}

		if (isPostingEnabled(this.runtime, this.accountId)) {
			this.startAutomatedPosting();
		}

		logger.success(
			{ agentId: this.runtime.agentId, accountId: this.accountId },
			"BlueSky agent manager started",
		);
	}

	async stop(): Promise<void> {
		this.running = false;

		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.actionTimer) clearInterval(this.actionTimer);
		if (this.postTimer) clearTimeout(this.postTimer);

		this.pollTimer = null;
		this.actionTimer = null;
		this.postTimer = null;

		await this.client.cleanup();
		logger.info(
			{ agentId: this.runtime.agentId, accountId: this.accountId },
			"BlueSky agent manager stopped",
		);
	}

	private startNotificationPolling(): void {
		const interval = getPollInterval(this.runtime, this.accountId);
		this.pollNotifications();
		this.pollTimer = setInterval(() => this.pollNotifications(), interval);
	}

	private async pollNotifications(): Promise<void> {
		if (!this.running) return;

		const { notifications } = await this.client.getNotifications(50);
		if (notifications.length === 0) return;

		const newNotifications = this.lastSeenAt
			? notifications.filter((n) => {
					const lastSeen = this.lastSeenAt;
					return lastSeen !== null && n.indexedAt > lastSeen;
				})
			: notifications;

		if (newNotifications.length > 0) {
			this.lastSeenAt = notifications[0].indexedAt;
			await this.runtime.setCache(
				cursorCacheKey(this.runtime.agentId, this.accountId),
				this.lastSeenAt,
			);

			for (const notification of newNotifications) {
				this.emitNotificationEvent(notification);
			}

			await this.client.updateSeenNotifications();
		}
	}

	private emitNotificationEvent(notification: BlueSkyNotification): void {
		const eventMap: Record<NotificationReason, string> = {
			mention: "bluesky.mention_received",
			reply: "bluesky.mention_received",
			follow: "bluesky.follow_received",
			like: "bluesky.like_received",
			repost: "bluesky.repost_received",
			quote: "bluesky.quote_received",
		};

		const event = eventMap[notification.reason];
		if (event) {
			const payload: BlueSkyNotificationEventPayload = {
				runtime: this.runtime,
				source: "bluesky",
				accountId: this.accountId,
				notification,
			};
			void this.runtime.emitEvent(event, payload);
		}
	}

	private startActionProcessing(): void {
		const interval = getActionInterval(this.runtime, this.accountId);
		this.processQueuedActions();
		this.actionTimer = setInterval(() => this.processQueuedActions(), interval);
	}

	private async processQueuedActions(): Promise<void> {
		if (!this.running) return;

		const max = getMaxActionsProcessing(this.runtime, this.accountId);
		const { notifications } = await this.client.getNotifications(max);

		for (const notification of notifications) {
			if (
				notification.reason === "mention" ||
				notification.reason === "reply"
			) {
				const payload: BlueSkyNotificationEventPayload = {
					runtime: this.runtime,
					source: "bluesky",
					accountId: this.accountId,
					notification,
				};
				void this.runtime.emitEvent("bluesky.should_respond", payload);
			}
		}
	}

	private startAutomatedPosting(): void {
		if (shouldPostImmediately(this.runtime, this.accountId)) {
			void this.createAutomatedPost();
		}
		this.scheduleNextPost();
	}

	private scheduleNextPost(): void {
		const { min, max } = getPostIntervalRange(this.runtime, this.accountId);
		const interval = Math.random() * (max - min) + min;

		this.postTimer = setTimeout(() => {
			if (this.running) {
				void this.createAutomatedPost().finally(() => this.scheduleNextPost());
			}
		}, interval);
	}

	private async createAutomatedPost(): Promise<void> {
		await withStandaloneTrajectory(
			this.runtime,
			{
				source: "plugin-bluesky:auto-post",
				metadata: {
					platform: "bluesky",
					kind: "public_post_generation",
					automated: true,
					accountId: this.accountId,
				},
			},
			async () => {
				setTrajectoryPurpose("background");
				const payload: BlueSkyCreatePostEventPayload = {
					runtime: this.runtime,
					source: "bluesky",
					automated: true,
					accountId: this.accountId,
				};
				await this.runtime.emitEvent("bluesky.create_post", payload);
			},
		);
	}
}
