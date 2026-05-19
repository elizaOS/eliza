import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	CAPABILITY_ROUTER_PROTOCOL_FIXTURE,
	type RuntimeBrokerCapabilityMethod,
} from "../core/src/capabilities/index.ts";

type Options = {
	host: string;
	port: number;
	token?: string;
	assetPath?: string;
};

const options = parseArgs(process.argv.slice(2));

const server = createServer(async (request, response) => {
	try {
		if (!isAuthorized(request, options.token)) {
			return json(response, 401, {
				ok: false,
				error: {
					code: "CAPABILITY_UNAVAILABLE",
					message: "Capability router request is not authorized.",
				},
			});
		}
		const url = new URL(request.url ?? "/", `http://${options.host}`);
		if (request.method === "GET" && url.pathname === "/v1/capabilities") {
			return json(response, 200, CAPABILITY_ROUTER_PROTOCOL_FIXTURE.availability);
		}
		if (
			request.method === "GET" &&
			url.pathname ===
				"/v1/capabilities/assets/fixture-remote-plugin/assets/fixture-view.js"
		) {
			const asset = CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset;
			response.statusCode = 200;
			response.setHeader("content-type", asset.contentType);
			if (options.assetPath) {
				response.end(readFileSync(options.assetPath));
				return;
			}
			response.end(Buffer.from(asset.bodyBase64, "base64"));
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/capabilities/invoke") {
			const body = await readJsonBody(request);
			if (!isRecord(body) || typeof body.method !== "string") {
				return json(response, 400, {
					ok: false,
					error: {
						code: "CAPABILITY_DECODE_FAILED",
						message: "Capability invoke body must include method.",
					},
				});
			}
			return json(response, 200, {
				ok: true,
				result: invokeFixture(body.method as RuntimeBrokerCapabilityMethod),
			});
		}
		return json(response, 404, {
			ok: false,
			error: { code: "CAPABILITY_UNAVAILABLE", message: "Not found." },
		});
	} catch (error) {
		return json(response, 500, {
			ok: false,
			error: {
				code: "CAPABILITY_REQUEST_FAILED",
				message: error instanceof Error ? error.message : String(error),
			},
		});
	}
});

server.listen(options.port, options.host, () => {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Could not resolve fixture server address.");
	}
	const baseUrl = `http://${options.host}:${address.port}`;
	console.log(JSON.stringify({ baseUrl, token: options.token ?? null }));
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

function invokeFixture(method: RuntimeBrokerCapabilityMethod) {
	switch (method) {
		case "plugin.modules.list":
			return { modules: [CAPABILITY_ROUTER_PROTOCOL_FIXTURE.module] };
		case "plugin.action.invoke":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.action;
		case "plugin.provider.get":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.provider;
		case "plugin.route.call":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.route;
		case "plugin.asset.get":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.asset;
		case "plugin.model.invoke":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.model;
		case "plugin.lifecycle.call":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.lifecycle;
		case "plugin.event.handle":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.event;
		case "plugin.service.call":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.service;
		case "plugin.appBridge.call":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.appBridge;
		case "plugin.evaluator.shouldRun":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorShouldRun;
		case "plugin.evaluator.prepare":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrepare;
		case "plugin.evaluator.prompt":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorPrompt;
		case "plugin.evaluator.process":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.evaluatorProcess;
		case "plugin.responseHandlerEvaluator.shouldRun":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.responseHandlerEvaluatorShouldRun;
		case "plugin.responseHandlerEvaluator.evaluate":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.responseHandlerEvaluatorEvaluate;
		case "plugin.responseHandlerFieldEvaluator.shouldRun":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.responseHandlerFieldEvaluatorShouldRun;
		case "plugin.responseHandlerFieldEvaluator.parse":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.responseHandlerFieldEvaluatorParse;
		case "plugin.responseHandlerFieldEvaluator.handle":
			return CAPABILITY_ROUTER_PROTOCOL_FIXTURE.results.responseHandlerFieldEvaluatorHandle;
		default:
			throw new Error(`Fixture server does not implement ${method}.`);
	}
}

function parseArgs(args: string[]): Options {
	let host = "127.0.0.1";
	let port = 0;
	let token: string | undefined;
	let assetPath: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--host") {
			host = requireValue(args, (index += 1), "--host");
		} else if (arg === "--port") {
			const value = Number(requireValue(args, (index += 1), "--port"));
			if (!Number.isInteger(value) || value < 0 || value > 65_535) {
				throw new Error("--port must be an integer from 0 to 65535.");
			}
			port = value;
		} else if (arg === "--token") {
			token = requireValue(args, (index += 1), "--token");
		} else if (arg === "--asset-path") {
			assetPath = requireValue(args, (index += 1), "--asset-path");
		} else if (arg === "--help" || arg === "-h") {
			console.log(
				[
					"Usage: bun packages/scripts/capability-router-fixture-server.ts [options]",
					"",
					"Options:",
					"  --host <host>   Bind host (default: 127.0.0.1)",
					"  --port <port>   Bind port, 0 chooses a free port (default: 0)",
					"  --token <token> Require bearer token",
					"  --asset-path <path> Serve a built fixture view bundle from disk",
				].join("\n"),
			);
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { host, port, ...(token ? { token } : {}), ...(assetPath ? { assetPath } : {}) };
}

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value.`);
	return value;
}

function isAuthorized(request: IncomingMessage, token: string | undefined): boolean {
	if (!token) return true;
	return request.headers.authorization === `Bearer ${token}`;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			data += chunk;
		});
		request.on("error", reject);
		request.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (error) {
				reject(error);
			}
		});
	});
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.statusCode = status;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
