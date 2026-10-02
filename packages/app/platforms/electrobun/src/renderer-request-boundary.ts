/** Reject rebinding requests before renderer credentials or API proxying. */
export function protectRendererRequest(
	port: number,
	serve: (request: Request) => Response | Promise<Response>,
): (request: Request) => Response | Promise<Response> {
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	return (request) => {
		const host = request.headers.get("host")?.toLowerCase();
		const url = new URL(request.url);
		const urlHost = `${url.hostname.toLowerCase()}:${url.port || "80"}`;
		if (
			!host ||
			!hosts.has(host) ||
			!hosts.has(urlHost) ||
			host !== urlHost ||
			url.protocol !== "http:" ||
			url.username ||
			url.password
		) {
			return new Response("Invalid renderer host", {
				status: 403,
				headers: { "Cache-Control": "no-store" },
			});
		}
		return serve(request);
	};
}
