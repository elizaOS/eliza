import { createServer, request as send } from "node:http";
import { expect, it } from "vitest";
import { protectRendererRequest } from "./renderer-request-boundary";

it("rejects rebound HTML and API requests on a real listener before serving", async () => {
	let calls = 0;
	let port = 0;
	const server = createServer(async (incoming, outgoing) => {
		const host = incoming.headers.host ?? `127.0.0.1:${port}`;
		const result = await protectRendererRequest(port, () => {
			calls++;
			return new Response("private-renderer-or-api-data");
		})(
			new Request(`http://${host}${incoming.url}`, {
				headers: incoming.headers.host ? { host } : {},
			}),
		);
		outgoing.writeHead(result.status, Object.fromEntries(result.headers));
		outgoing.end(await result.text());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as { port: number }).port;
	const fetch = (host: string, path: string) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			const r = send(
				{ host: "127.0.0.1", port, path, headers: { host } },
				(response) => {
					let body = "";
					response.setEncoding("utf8");
					response.on("data", (part) => {
						body += part;
					});
					response.on("end", () =>
						resolve({ status: response.statusCode ?? 0, body }),
					);
				},
			);
			r.on("error", reject);
			r.end();
		});
	try {
		for (const host of [
			`attacker.example:${port}`,
			`127.0.0.1:${port + 1}`,
			`localhost.evil:${port}`,
			`localhost.:${port}`,
		]) {
			for (const path of ["/", "/api/secrets/inventory", "/ws"]) {
				const result = await fetch(host, path);
				expect(result.status).toBe(403);
				expect(result.body).not.toContain("private-renderer-or-api-data");
			}
		}
		expect(calls).toBe(0);
		for (const host of [
			`127.0.0.1:${port}`,
			`localhost:${port}`,
			`LOCALHOST:${port}`,
		]) {
			expect((await fetch(host, "/")).status).toBe(200);
		}
		expect(calls).toBe(3);
		expect(
			protectRendererRequest(
				port,
				() => new Response("private"),
			)(new Request(`http://127.0.0.1:${port}/`)),
		).toMatchObject({ status: 403 });
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
