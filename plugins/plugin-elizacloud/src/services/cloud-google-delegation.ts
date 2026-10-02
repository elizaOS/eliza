import { DelegationRecordStore } from "../db/delegation-records";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
/** Owner-bound, revocable unattended Google reads using existing Cloud app delegation. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type DurableRecordStore,
	type IAgentRuntime,
	Service,
} from "@elizaos/core";
import {
	AppDelegationClient,
	type AppDelegationScope,
	type AppGoogleConnection,
} from "@elizaos/cloud-sdk/app-delegation";
import { buildAppAuthorizeUrl } from "@elizaos/cloud-sdk/app-auth";
const NS = "eliza_cloud_google_delegation_v1";
const DAY = 86400000;
const digest = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class CloudDelegationError extends Error {
	constructor(public status = 409) {
		super("Cloud connection needs explicit review or reconnection");
	}
}
// All delegated provider JSON is untrusted, including optional nested metadata.
function isProviderObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function providerObject(value: unknown): Record<string, unknown> {
	if (!isProviderObject(value)) throw new CloudDelegationError();
	return value;
}
function providerItems(value: unknown, limit: number): unknown[] {
	if (!Array.isArray(value) || value.length > limit)
		throw new CloudDelegationError();
	return value;
}
function providerString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new CloudDelegationError();
	return value;
}
function providerId(value: unknown): string {
	const id = providerString(value);
	if (!id) throw new CloudDelegationError();
	return id;
}
function providerDate(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const date = providerObject(value);
	const dateTime = providerString(date.dateTime);
	const day = providerString(date.date);
	return dateTime ?? day;
}
function providerReceivedAt(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value !== "string" || !/^\d+$/.test(value))
		throw new CloudDelegationError();
	const date = new Date(Number(value));
	if (!Number.isFinite(date.getTime())) throw new CloudDelegationError();
	return date.toISOString();
}
export interface VerifiedCloudPrincipal {
	ownerId: string;
	cloudUserId: string;
}
export interface DelegationVault {
	get(
		ref: string,
		options?: { reveal?: boolean; caller?: string },
	): Promise<string>;
	putSecret(input: {
		vaultRef: string;
		agentId: string;
		provider: string;
		accountId: string;
		credentialType: string;
		value: string;
		caller: string;
	}): Promise<string>;
	remove(ref: string): Promise<void>;
}
export interface CloudDelegationConfig {
	appId: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	siteUrl: string;
	apiBaseUrl: string;
}
interface Enrollment {
	type: "enrollment";
	ownerId: string;
	cloudUserId: string;
	revision: string;
	scopes: AppDelegationScope[];
	expiresAt: number;
	consumed: boolean;
	grantId?: string;
	failed?: boolean;
}
interface Grant {
	type: "grant";
	id: string;
	ownerId: string;
	cloudUserId: string;
	revision: string;
	scopes: AppDelegationScope[];
	expiresAt: number;
	secretRef: string;
	revoked: boolean;
	revocationConfirmed?: boolean;
}
export interface CloudGoogleAccount {
	accountId: string;
	accountRevision: string;
	label: string;
	kinds: string[];
	expiresAt: string;
}
function required(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > 16384)
		throw new CloudDelegationError();
}
function strictKeys(v: Record<string, unknown>, keys: string[]) {
	if (Object.keys(v).some((k) => !keys.includes(k)))
		throw new CloudDelegationError(400);
}
export class CloudGoogleDelegation {
	private readonly revision: string;
	constructor(
		private readonly store: DurableRecordStore,
		private readonly vault: DelegationVault,
		private readonly config: CloudDelegationConfig,
		private readonly client = new AppDelegationClient(config),
		private readonly now = Date.now,
	) {
		for (const v of Object.values(config)) required(v);
		for (const value of [
			config.siteUrl,
			config.apiBaseUrl,
			config.redirectUri,
		]) {
			const u = new URL(value);
			if (u.protocol !== "https:" || u.username || u.password || u.hash)
				throw new CloudDelegationError();
		}
		this.revision = digest(config);
	}
	private key(state: string) {
		return "state:" + digest(state);
	}
	async begin(
		principal: VerifiedCloudPrincipal,
		input: Record<string, unknown>,
	) {
		strictKeys(input, ["confirmed", "kinds"]);
		required(principal.ownerId);
		required(principal.cloudUserId);
		if (
			input.confirmed !== true ||
			!Array.isArray(input.kinds) ||
			input.kinds.length < 1 ||
			input.kinds.length > 2 ||
			input.kinds.some((k) => !["email", "calendar"].includes(k)) ||
			new Set(input.kinds).size !== input.kinds.length
		)
			throw new CloudDelegationError(400);
		const scopes: AppDelegationScope[] = [
			"identity",
			"google.basic_identity",
			...(input.kinds.includes("email")
				? ["google.gmail.triage" as const]
				: []),
			...(input.kinds.includes("calendar")
				? ["google.calendar.read" as const]
				: []),
		];
		const state = randomBytes(32).toString("base64url"),
			expiresAt = this.now() + 600000;
		await this.store.set<Enrollment>(NS, this.key(state), {
			type: "enrollment",
			...principal,
			revision: this.revision,
			scopes,
			expiresAt,
			consumed: false,
		});
		return {
			authUrl: buildAppAuthorizeUrl({
				appId: this.config.appId,
				redirectUri: this.config.redirectUri,
				state,
				baseUrl: this.config.siteUrl,
				delegation: { clientId: this.config.clientId, scopes },
			}),
			expiresAt: new Date(expiresAt).toISOString(),
		};
	}
	async complete(
		principal: VerifiedCloudPrincipal,
		input: Record<string, unknown>,
	) {
		strictKeys(input, ["state", "code"]);
		required(input.state);
		required(input.code);
		const state = input.state,
			code = input.code;
		const enrollment = await this.store.transaction(async () => {
			const e = await this.store.get<Enrollment>(NS, this.key(state));
			if (
				!e ||
				e.type !== "enrollment" ||
				e.consumed ||
				e.expiresAt <= this.now() ||
				e.revision !== this.revision ||
				e.ownerId !== principal.ownerId ||
				e.cloudUserId !== principal.cloudUserId
			)
				throw new CloudDelegationError();
			await this.store.set(NS, this.key(state), { ...e, consumed: true });
			return e;
		});
		let token: string | undefined;
		let ref: string | undefined;
		try {
			const response = await this.client.exchange(code, this.config.redirectUri);
			if (!response) throw new CloudDelegationError();
			token = response.data.token;
			const data = response.data,
				expiry = Date.parse(data.expiresAt);
			if (
				data.appId !== this.config.appId ||
				data.user.id !== principal.cloudUserId ||
				!Number.isFinite(expiry) ||
				expiry <= this.now() ||
				expiry > this.now() + 7 * DAY ||
				data.scopes.length !== enrollment.scopes.length ||
				enrollment.scopes.some((s) => !data.scopes.includes(s))
			)
				throw new CloudDelegationError();
			required(token);
			const identity = await this.client.identity(token);
			if (!identity || identity.data.id !== principal.cloudUserId)
				throw new CloudDelegationError();
			const id = randomUUID();
			ref = "cloud-delegation." + this.store.agentId + "." + id;
			const stored = await this.vault.putSecret({
				vaultRef: ref,
				agentId: this.store.agentId,
				provider: "eliza-cloud",
				accountId: id,
				credentialType: "app-delegation",
				value: token,
				caller: "cloud-google-delegation",
			});
			if (stored !== ref) throw new CloudDelegationError();
			const grant: Grant = {
				type: "grant",
				id,
				...principal,
				revision: this.revision,
				scopes: data.scopes,
				expiresAt: expiry,
				secretRef: ref,
				revoked: false,
			};
			await this.store.transaction(async () => {
				await this.store.set(NS, "grant:" + id, grant);
				await this.store.set(NS, this.key(state), {
					...enrollment,
					consumed: true,
					grantId: id,
				});
			});
			return { grantId: id, expiresAt: data.expiresAt, scopes: data.scopes };
		} catch (error) {
			try {
				await this.store.set(NS, this.key(state), {
					...enrollment,
					consumed: true,
					failed: true,
				});
			} catch {
				/* The already-consumed state remains unusable; still compensate the remote grant below. */
			}
			// A failed binding never becomes usable. Best-effort remote compensation;
			// Cloud's credential still has its seven-day expiry if transport is lost.
			if (typeof token === "string" && token.length)
				try {
					await this.client.revoke(token);
				} catch {}
			if (ref)
				try {
					await this.vault.remove(ref);
				} catch {}
			throw error;
		}
	}
	async status(
		principal: VerifiedCloudPrincipal,
		input: Record<string, unknown>,
	) {
		strictKeys(input, ["state"]);
		required(input.state);
		const e = await this.store.get<Enrollment>(NS, this.key(input.state));
		if (
			!e ||
			e.type !== "enrollment" ||
			e.ownerId !== principal.ownerId ||
			e.cloudUserId !== principal.cloudUserId ||
			e.revision !== this.revision
		)
			throw new CloudDelegationError();
		if (e.grantId) {
			const g = await this.grant(principal.ownerId, e.grantId, true);
			if (g.revoked || g.expiresAt <= this.now()) return { status: "failed" };
			return {
				status: "complete",
				grantId: g.id,
				expiresAt: new Date(g.expiresAt).toISOString(),
			};
		}
		return {
			status:
				e.failed || e.expiresAt <= this.now()
					? "failed"
					: e.consumed
						? "finishing"
						: "waiting",
		};
	}
	async cancel(
		principal: VerifiedCloudPrincipal,
		input: Record<string, unknown>,
	) {
		strictKeys(input, ["state", "confirmed"]);
		required(input.state);
		if (input.confirmed !== true) throw new CloudDelegationError(400);
		await this.store.transaction(async () => {
			const e = await this.store.get<Enrollment>(
				NS,
				this.key(input.state as string),
			);
			if (
				!e ||
				e.type !== "enrollment" ||
				e.ownerId !== principal.ownerId ||
				e.cloudUserId !== principal.cloudUserId ||
				e.consumed
			)
				throw new CloudDelegationError();
			await this.store.set(NS, this.key(input.state as string), {
				...e,
				consumed: true,
				failed: true,
			});
		});
		return { cancelled: true };
	}
	private async grant(owner: string, id: string, allowRevoked = false) {
		const grant = await this.store.get<Grant>(NS, "grant:" + id);
		if (
			!grant ||
			grant.type !== "grant" ||
			grant.ownerId !== owner ||
			(!allowRevoked && grant.revision !== this.revision) ||
			(!allowRevoked && (grant.revoked || grant.expiresAt <= this.now()))
		)
			throw new CloudDelegationError();
		return grant;
	}
	private async credential(grant: Grant) {
		const token = await this.vault.get(grant.secretRef, {
			reveal: true,
			caller: "cloud-google-delegation",
		});
		required(token);
		return token;
	}
	async revocations(owner: string) {
		return {
			grants: (await this.store.getAll<Grant | Enrollment>(NS))
				.filter(
					(g): g is Grant =>
						g.type === "grant" &&
						g.ownerId === owner &&
						g.revoked &&
						!g.revocationConfirmed,
				)
				.map((g) => ({
					grantId: g.id,
					expiresAt: new Date(g.expiresAt).toISOString(),
				})),
		};
	}
	async revoke(owner: string, input: Record<string, unknown>) {
		strictKeys(input, ["grantId", "confirmed"]);
		required(input.grantId);
		if (input.confirmed !== true) throw new CloudDelegationError(400);
		const grant = await this.store.transaction(async () => {
			const g = await this.grant(owner, input.grantId as string, true);
			await this.store.set(NS, "grant:" + g.id, { ...g, revoked: true });
			return g;
		});
		if (grant.revocationConfirmed)
			return { revoked: true, remoteRevocation: "confirmed" };
		try {
			if (grant.expiresAt > this.now())
				await this.client.revoke(await this.credential(grant));
			await this.vault.remove(grant.secretRef);
			await this.store.set(NS, "grant:" + grant.id, {
				...grant,
				revoked: true,
				revocationConfirmed: true,
			});
			return { revoked: true, remoteRevocation: "confirmed" };
		} catch {
			return { revoked: true, remoteRevocation: "retry_required" };
		}
	}
	private descriptor(
		grant: Grant,
		connection: AppGoogleConnection,
	): CloudGoogleAccount {
		const kinds = [
			...(grant.scopes.includes("google.gmail.triage") &&
			connection.grantedCapabilities.includes("google.gmail.triage")
				? ["email"]
				: []),
			...(grant.scopes.includes("google.calendar.read") &&
			connection.grantedCapabilities.includes("google.calendar.read")
				? ["calendar"]
				: []),
		];
		return {
			accountId: "cloud:" + grant.id + ":" + digest(connection.connectionId),
			accountRevision: digest({
				grant: grant.id,
				revision: grant.revision,
				expiresAt: grant.expiresAt,
				connection: connection.connectionId,
				capabilities: [...connection.grantedCapabilities].sort(),
			}),
			label:
				typeof connection.identity?.email === "string"
					? connection.identity.email.slice(0, 200)
					: "Eliza Cloud Google " +
						String(connection.connectionId).slice(0, 12),
			kinds,
			expiresAt: new Date(grant.expiresAt).toISOString(),
		};
	}
	private async connections(grant: Grant) {
		const token = await this.credential(grant),
			who = await this.client.identity(token);
		if (!who || who.data.id !== grant.cloudUserId)
			throw new CloudDelegationError();
		const result = await this.client.googleConnections(token);
		await this.grant(grant.ownerId, grant.id);
		if (!result) throw new CloudDelegationError();
		return result.data.filter(
			(c) =>
				c.connected &&
				typeof c.connectionId === "string" &&
				!!c.connectionId &&
				c.grantedCapabilities.includes("google.basic_identity"),
		);
	}
	async list(owner: string) {
		const grants = (await this.store.getAll<Grant | Enrollment>(NS)).filter(
			(g): g is Grant =>
				g.type === "grant" &&
				g.ownerId === owner &&
				!g.revoked &&
				g.expiresAt > this.now() &&
				g.revision === this.revision,
		);
		const accounts: CloudGoogleAccount[] = [];
		for (const grant of grants)
			for (const connection of await this.connections(grant)) {
				const item = this.descriptor(grant, connection);
				if (item.kinds.length) accounts.push(item);
			}
		return { accounts };
	}
	async selected(
		owner: string,
		accountId: string,
		revision: string,
		kind: "email" | "calendar",
	) {
		const parts = accountId.split(":");
		if (parts.length !== 3 || parts[0] !== "cloud")
			throw new CloudDelegationError();
		const grant = await this.grant(owner, parts[1]);
		const connection = (await this.connections(grant)).find(
			(c) => digest(c.connectionId) === parts[2],
		);
		if (!connection) throw new CloudDelegationError();
		const item = this.descriptor(grant, connection);
		if (item.accountRevision !== revision || !item.kinds.includes(kind))
			throw new CloudDelegationError();
		return { grant, connection, item };
	}
	private async request(
		owner: string,
		accountId: string,
		revision: string,
		kind: "email" | "calendar",
		url: string,
	) {
		const { grant, connection } = await this.selected(
			owner,
			accountId,
			revision,
			kind,
		);
		const response = await this.client.googleRequest(
			await this.credential(grant),
			{ connectionId: connection.connectionId!, method: "GET", url },
		);
		if (!response.ok) throw new CloudDelegationError();
		const result: unknown = await response.json();
		await this.selected(owner, accountId, revision, kind);
		return providerObject(result);
	}
	async calendars(owner: string, accountId: string, revision: string) {
		const data = await this.request(
			owner,
			accountId,
			revision,
			"calendar",
			"https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50&minAccessRole=reader",
		);
		return {
			calendars: providerItems(data.items, 50)
				.map((value) => {
					const c = providerObject(value);
					return {
						calendarId: providerId(c.id),
						summary: (providerString(c.summary) ?? "").slice(0, 200),
						timeZone: providerString(c.timeZone),
					};
				})
				.filter((c) => c.calendarId !== "primary"),
			nextPageToken: providerString(data.nextPageToken),
		};
	}
	async read(
		owner: string,
		selected: {
			accountId: string;
			accountRevision: string;
			kind: "email" | "calendar";
			calendarId?: string;
			windowHours: number;
			maxItems: number;
		},
		now: number,
	) {
		if (
			!Number.isInteger(selected.windowHours) ||
			selected.windowHours < 1 ||
			selected.windowHours > 168 ||
			!Number.isInteger(selected.maxItems) ||
			selected.maxItems < 1 ||
			selected.maxItems > 25 ||
			!Number.isFinite(now)
		)
			throw new CloudDelegationError(400);
		const call = (url: string) =>
			this.request(
				owner,
				selected.accountId,
				selected.accountRevision,
				selected.kind,
				url,
			);
		if (selected.kind === "calendar") {
			if (!selected.calendarId || selected.calendarId === "primary")
				throw new CloudDelegationError();
			const url = new URL(
				"https://www.googleapis.com/calendar/v3/calendars/" +
					encodeURIComponent(selected.calendarId) +
					"/events",
			);
			for (const [k, v] of Object.entries({
				timeMin: new Date(now).toISOString(),
				timeMax: new Date(now + selected.windowHours * 3600000).toISOString(),
				maxResults: String(selected.maxItems),
				singleEvents: "true",
				orderBy: "startTime",
			}))
				url.searchParams.set(k, v);
			const data = await call(url.href);
			return {
				events: providerItems(data.items, selected.maxItems).map((value) => {
					const e = providerObject(value);
					return {
						id: providerId(e.id),
						calendarId: selected.calendarId,
						title: providerString(e.summary),
						start: providerDate(e.start),
						end: providerDate(e.end),
						status: providerString(e.status),
					};
				}),
				nextPageToken: providerString(data.nextPageToken),
			};
		}
		const url = new URL(
			"https://gmail.googleapis.com/gmail/v1/users/me/messages",
		);
		url.searchParams.set(
			"q",
			"in:inbox after:" +
				Math.floor((now - selected.windowHours * 3600000) / 1000),
		);
		url.searchParams.set("maxResults", String(selected.maxItems));
		const list = await call(url.href);
		if (list.messages === undefined) return [];
		const messages = [];
		for (const value of providerItems(list.messages, selected.maxItems)) {
			const m = providerObject(value);
			const id = providerId(m.id);
			if (!/^[-\w]+$/.test(id)) throw new CloudDelegationError();
			const d = await call(
				"https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
					id +
					"?format=metadata&metadataHeaders=Subject",
			);
			let subject: string | undefined;
			if (d.payload !== undefined) {
				const payload = providerObject(d.payload);
				if (payload.headers !== undefined) {
					for (const value of providerItems(payload.headers, 1000)) {
						const header = providerObject(value);
						const name = providerString(header.name);
						const text = providerString(header.value);
						if (name?.toLowerCase() === "subject" && subject === undefined)
							subject = text;
					}
				}
			}
			messages.push({
				id,
				subject,
				snippet: providerString(d.snippet),
				receivedAt: providerReceivedAt(d.internalDate),
			});
		}
		return messages;
	}
}

/** The service has no network or credential side effects until explicit enrollment. */
export class CloudGoogleDelegationService extends Service {
	static serviceType = "cloud_google_delegation";
	capabilityDescription = "Owner-reviewed Cloud Google read delegation";
	static async start(runtime: IAgentRuntime) {
		return new CloudGoogleDelegationService(runtime);
	}
	async stop() {}
	private engine() {
		const setting = (key: string) => {
			const v = this.runtime.getSetting(key);
			required(v);
			return v;
		};
		const store =
			this.runtime.adapter.recordStore ??
			(this.runtime.adapter.db
				? new DelegationRecordStore(
						this.runtime.agentId,
						this.runtime.adapter.db as NodePgDatabase,
					)
				: undefined);
		const vault = this.runtime.getService(
			"connector_credential_store",
		) as unknown as DelegationVault | null;
		if (
			!store ||
			store.agentId !== this.runtime.agentId ||
			!vault ||
			typeof vault.putSecret !== "function" ||
			typeof vault.get !== "function" ||
			typeof vault.remove !== "function"
		)
			throw new CloudDelegationError(503);
		return new CloudGoogleDelegation(store, vault, {
			appId: setting("ELIZA_CLOUD_DELEGATION_APP_ID"),
			clientId: setting("ELIZA_CLOUD_DELEGATION_CLIENT_ID"),
			clientSecret: setting("ELIZA_CLOUD_DELEGATION_CLIENT_SECRET"),
			redirectUri: setting("ELIZA_CLOUD_DELEGATION_REDIRECT_URI"),
			siteUrl: setting("ELIZA_CLOUD_DELEGATION_SITE_URL"),
			apiBaseUrl: setting("ELIZA_CLOUD_DELEGATION_API_URL"),
		});
	}
	begin(p: VerifiedCloudPrincipal, i: Record<string, unknown>) {
		return this.engine().begin(p, i);
	}
	complete(p: VerifiedCloudPrincipal, i: Record<string, unknown>) {
		return this.engine().complete(p, i);
	}
	status(p: VerifiedCloudPrincipal, i: Record<string, unknown>) {
		return this.engine().status(p, i);
	}
	cancel(p: VerifiedCloudPrincipal, i: Record<string, unknown>) {
		return this.engine().cancel(p, i);
	}
	revocations(owner: string) {
		return this.engine().revocations(owner);
	}
	revoke(owner: string, i: Record<string, unknown>) {
		return this.engine().revoke(owner, i);
	}
	list(owner: string) {
		return this.engine().list(owner);
	}
	selected(...a: Parameters<CloudGoogleDelegation["selected"]>) {
		return this.engine().selected(...a);
	}
	calendars(...a: Parameters<CloudGoogleDelegation["calendars"]>) {
		return this.engine().calendars(...a);
	}
	read(...a: Parameters<CloudGoogleDelegation["read"]>) {
		return this.engine().read(...a);
	}
}
