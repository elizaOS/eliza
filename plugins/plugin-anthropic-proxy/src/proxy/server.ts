/**
 * In-process http proxy server. Wraps the request/response pipeline ported
 * from proxy.js v2.2.3 in a controllable Service-friendly object.
 */

import {
	type IncomingMessage,
	type Server,
	createServer,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import {
	CC_VERSION,
	DEFAULT_PORT,
	DEFAULT_PROP_RENAMES,
	DEFAULT_REPLACEMENTS,
	DEFAULT_REVERSE_MAP,
	DEFAULT_TOOL_RENAMES,
	REQUIRED_BETAS,
	UPSTREAM_HOST,
	VERSION,
} from "./constants.js";
import {
	loadCredentials,
	type LoadResult,
	type OAuthCreds,
} from "../utils/credentials-loader.js";
import {
	processBody,
	type ProcessBodyConfig,
} from "./process-body.js";
import { reverseMap } from "./reverse-map.js";
import type { Pair } from "./sanitize.js";
import { createSseStream } from "./sse-rewrite.js";
import { getStainlessHeaders } from "./stainless-headers.js";

export interface ProxyServerOptions {
	port?: number;
	bindHost?: string;
	credentialsPath?: string;
	envToken?: string;
	proxyAuthToken?: string;
	verbose?: boolean;
	replacements?: ReadonlyArray<Pair>;
	toolRenames?: ReadonlyArray<Pair>;
	propRenames?: ReadonlyArray<Pair>;
	reverseMap?: ReadonlyArray<Pair>;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export interface ProxyStats {
	version: string;
	ccVersion: string;
	port: number;
	bindHost: string;
	requestsServed: number;
	startedAt: number;
	uptimeSec: number;
	credsLoaded: boolean;
	credsSource?: string;
	credsPath?: string;
	subscriptionType?: string;
	tokenExpiresInHours?: number | null;
	layers: {
		stringReplacements: number;
		toolNameRenames: number;
		propertyRenames: number;
	};
}

const DEFAULT_BIND = "127.0.0.1";

const noopLogger: NonNullable<ProxyServerOptions["logger"]> = {
	info: (_msg: string) => undefined,
	warn: (_msg: string) => undefined,
	error: (_msg: string) => undefined,
};

export class ProxyServer {
	private server: Server | null = null;
	private requestCount = 0;
	private startedAt = 0;
	private listening = false;

	private readonly port: number;
	private readonly bindHost: string;
	private readonly credentialsPath?: string;
	private readonly envToken?: string;
	private readonly proxyAuthToken?: string;
	private readonly verbose: boolean;
	private readonly replacements: ReadonlyArray<Pair>;
	private readonly toolRenames: ReadonlyArray<Pair>;
	private readonly propRenames: ReadonlyArray<Pair>;
	private readonly reverseMapPairs: ReadonlyArray<Pair>;
	private readonly logger: NonNullable<ProxyServerOptions["logger"]>;

	private cachedCreds: OAuthCreds | null = null;
	private credsError?: string;

	constructor(opts: ProxyServerOptions = {}) {
		this.port = opts.port ?? DEFAULT_PORT;
		this.bindHost = opts.bindHost ?? DEFAULT_BIND;
		this.credentialsPath = opts.credentialsPath;
		this.envToken = opts.envToken;
		this.proxyAuthToken = opts.proxyAuthToken;
		this.verbose = opts.verbose ?? false;
		this.replacements = opts.replacements ?? DEFAULT_REPLACEMENTS;
		this.toolRenames = opts.toolRenames ?? DEFAULT_TOOL_RENAMES;
		this.propRenames = opts.propRenames ?? DEFAULT_PROP_RENAMES;
		this.reverseMapPairs = opts.reverseMap ?? DEFAULT_REVERSE_MAP;
		this.logger = opts.logger ?? noopLogger;
	}

	private getCreds(): LoadResult {
		const result = loadCredentials({
			credentialsPath: this.credentialsPath,
			envToken: this.envToken,
		});
		if (result.creds) this.cachedCreds = result.creds;
		if (result.error) this.credsError = result.error;
		return result;
	}

	getStats(): ProxyStats {
		const now = Date.now();
		const result = this.getCreds();
		const creds = result.creds;
		let tokenExpiresInHours: number | null = null;
		if (creds && Number.isFinite(creds.expiresAt)) {
			tokenExpiresInHours = (creds.expiresAt - now) / 3600000;
		}
		return {
			version: VERSION,
			ccVersion: CC_VERSION,
			port: this.port,
			bindHost: this.bindHost,
			requestsServed: this.requestCount,
			startedAt: this.startedAt,
			uptimeSec: this.startedAt
				? Math.floor((now - this.startedAt) / 1000)
				: 0,
			credsLoaded: !!creds,
			credsSource: creds?.source,
			credsPath: creds?.path,
			subscriptionType: creds?.subscriptionType,
			tokenExpiresInHours,
			layers: {
				stringReplacements: this.replacements.length,
				toolNameRenames: this.toolRenames.length,
				propertyRenames: this.propRenames.length,
			},
		};
	}

	async start(): Promise<void> {
		if (this.listening) return;
		const result = this.getCreds();
		if (!result.creds) {
			throw new Error(result.error ?? "credentials load failed");
		}

		this.server = createServer((req, res) => this.handleRequest(req, res));
		this.startedAt = Date.now();
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.port, this.bindHost, () => {
				this.server!.removeListener("error", reject);
				this.listening = true;
				this.logger.info(
					`anthropic-proxy listening on http://${this.bindHost}:${this.port} (cc=${CC_VERSION})`,
				);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server || !this.listening) return;
		await new Promise<void>((resolve) => {
			this.server!.close(() => {
				this.listening = false;
				resolve();
			});
		});
		this.server = null;
	}

	getUrl(): string {
		return `http://${this.bindHost}:${this.port}`;
	}

	isListening(): boolean {
		return this.listening;
	}

	private buildPipelineConfig(): ProcessBodyConfig {
		return {
			replacements: this.replacements,
			toolRenames: this.toolRenames,
			propRenames: this.propRenames,
		};
	}

	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		if (req.url === "/health" && req.method === "GET") {
			this.handleHealth(res);
			return;
		}
		if (this.proxyAuthToken && !this.isAuthorized(req)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { message: "unauthorized" } }));
			return;
		}

		this.requestCount++;
		const reqNum = this.requestCount;
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			let body = Buffer.concat(chunks);
			const credsResult = this.getCreds();
			if (!credsResult.creds) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						type: "error",
						error: { message: credsResult.error ?? "no credentials" },
					}),
				);
				return;
			}
			const creds = credsResult.creds;

			let bodyStr = body.toString("utf8");
			const originalSize = bodyStr.length;
			const processed = processBody(bodyStr, this.buildPipelineConfig());
			bodyStr = processed.body;
			body = Buffer.from(bodyStr, "utf8");

			const headers: Record<string, string | number> = {};
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined) continue;
				const lk = key.toLowerCase();
				if (
					lk === "host" ||
					lk === "connection" ||
					lk === "authorization" ||
					lk === "x-api-key" ||
					lk === "content-length" ||
					lk === "x-session-affinity"
				)
					continue;
				headers[key] = Array.isArray(value) ? value.join(",") : value;
			}
			headers["authorization"] = `Bearer ${creds.accessToken}`;
			headers["content-length"] = body.length;
			headers["accept-encoding"] = "identity";
			headers["anthropic-version"] = "2023-06-01";

			const ccHeaders = getStainlessHeaders();
			for (const [k, v] of Object.entries(ccHeaders)) {
				headers[k] = v;
			}

			const existingBeta = (headers["anthropic-beta"] as string | undefined) ?? "";
			const betas = existingBeta ? existingBeta.split(",").map((b) => b.trim()) : [];
			for (const b of REQUIRED_BETAS) {
				if (!betas.includes(b)) betas.push(b);
			}
			headers["anthropic-beta"] = betas.join(",");

			if (this.verbose) {
				this.logger.info(
					`#${reqNum} ${req.method} ${req.url} (${originalSize}b -> ${body.length}b)`,
				);
			}

			const upstream = httpsRequest(
				{
					hostname: UPSTREAM_HOST,
					port: 443,
					path: req.url,
					method: req.method,
					headers,
				},
				(upRes) => {
					const status = upRes.statusCode ?? 502;
					if (status !== 200 && status !== 201) {
						const errChunks: Buffer[] = [];
						upRes.on("data", (c) => errChunks.push(c));
						upRes.on("end", () => {
							let errBody = Buffer.concat(errChunks).toString("utf8");
							errBody = reverseMap(errBody, {
								toolRenames: this.toolRenames,
								propRenames: this.propRenames,
								reverseMap: this.reverseMapPairs,
							});
							const nh = { ...upRes.headers };
							delete nh["transfer-encoding"];
							nh["content-length"] = String(Buffer.byteLength(errBody));
							res.writeHead(status, nh as Record<string, string>);
							res.end(errBody);
						});
						return;
					}

					if (
						upRes.headers["content-type"] &&
						upRes.headers["content-type"].includes("text/event-stream")
					) {
						const sseHeaders = { ...upRes.headers };
						delete sseHeaders["content-length"];
						delete sseHeaders["transfer-encoding"];
						res.writeHead(status, sseHeaders as Record<string, string>);
						const stream = createSseStream(
							(text) =>
								reverseMap(text, {
									toolRenames: this.toolRenames,
									propRenames: this.propRenames,
									reverseMap: this.reverseMapPairs,
								}),
							(text) => res.write(text),
							() => res.end(),
						);
						upRes.on("data", (chunk: Buffer) => stream.write(chunk));
						upRes.on("end", () => stream.end());
					} else {
						const respChunks: Buffer[] = [];
						upRes.on("data", (c) => respChunks.push(c));
						upRes.on("end", () => {
							let respBody = Buffer.concat(respChunks).toString("utf8");
							respBody = reverseMap(respBody, {
								toolRenames: this.toolRenames,
								propRenames: this.propRenames,
								reverseMap: this.reverseMapPairs,
							});
							const nh = { ...upRes.headers };
							delete nh["transfer-encoding"];
							nh["content-length"] = String(Buffer.byteLength(respBody));
							res.writeHead(status, nh as Record<string, string>);
							res.end(respBody);
						});
					}
				},
			);
			upstream.on("error", (e) => {
				this.logger.error(`#${reqNum} upstream error: ${(e as Error).message}`);
				if (!res.headersSent) {
					res.writeHead(502, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							type: "error",
							error: { message: (e as Error).message },
						}),
					);
				}
			});
			upstream.write(body);
			upstream.end();
		});
	}

	private isAuthorized(req: IncomingMessage): boolean {
		const auth = req.headers.authorization;
		if (auth === `Bearer ${this.proxyAuthToken}`) return true;
		return req.headers["x-claude-max-proxy-token"] === this.proxyAuthToken;
	}

	private handleHealth(res: ServerResponse): void {
		try {
			const stats = this.getStats();
			const status = stats.credsLoaded
				? stats.tokenExpiresInHours === null ||
					stats.tokenExpiresInHours > 0
					? "ok"
					: "token_expired"
				: "no_credentials";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					status,
					proxy: "anthropic-proxy",
					version: stats.version,
					requestsServed: stats.requestsServed,
					uptime: `${stats.uptimeSec}s`,
					tokenExpiresInHours:
						stats.tokenExpiresInHours === null
							? "n/a"
							: stats.tokenExpiresInHours.toFixed(1),
					subscriptionType: stats.subscriptionType ?? "unknown",
					layers: stats.layers,
				}),
			);
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					status: "error",
					message: (e as Error).message,
				}),
			);
		}
	}
}
