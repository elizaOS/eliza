/**
 * The pinned transport against real local HTTP and HTTPS servers, one per
 * loopback family. The HTTPS servers present a certificate that names
 * localhost, 127.0.0.1 and ::1, so each request runs Node's own certificate
 * check for the host it was given. The servers echo the Host header and the
 * TLS server name (SNI) they received. Cases come from
 * quint/PinnedTransportHost.qnt (check-pinned-transport-host.mjs passes the
 * generated ones through ELIZA_PINNED_TRANSPORT_MODEL_CASES).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchWithSsrfGuard } from "../src/network/fetch-guard.ts";
import { nodePinnedFetch } from "../src/network/node-pinned-fetch.ts";

interface ModelCase {
	hostKind: 0 | 1 | 2;
	scheme: 0 | 1;
	sni: 0 | 1;
	hostHeaderBracketed: boolean;
	outcome: 0;
}

const URL_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
const ADDRESSES = ["127.0.0.1", "127.0.0.1", "::1"] as const;
const SCHEMES = ["http", "https"] as const;

const modelCases: ModelCase[] = process.env.ELIZA_PINNED_TRANSPORT_MODEL_CASES
	? JSON.parse(
			readFileSync(process.env.ELIZA_PINNED_TRANSPORT_MODEL_CASES, "utf8"),
		)
	: [
			{
				hostKind: 0,
				scheme: 0,
				sni: 0,
				hostHeaderBracketed: false,
				outcome: 0,
			},
			{
				hostKind: 0,
				scheme: 1,
				sni: 1,
				hostHeaderBracketed: false,
				outcome: 0,
			},
			{
				hostKind: 1,
				scheme: 0,
				sni: 0,
				hostHeaderBracketed: false,
				outcome: 0,
			},
			{
				hostKind: 1,
				scheme: 1,
				sni: 0,
				hostHeaderBracketed: false,
				outcome: 0,
			},
			{ hostKind: 2, scheme: 0, sni: 0, hostHeaderBracketed: true, outcome: 0 },
			{ hostKind: 2, scheme: 1, sni: 0, hostHeaderBracketed: true, outcome: 0 },
		];

const hasIpv6Loopback = Object.values(networkInterfaces()).some((entries) =>
	entries?.some((entry) => entry.family === "IPv6" && entry.address === "::1"),
);

describe("pinned transport host, Host header and TLS server name", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "eliza-pinned-host-"));
	const servers = new Map<string, http.Server>();
	const ports = new Map<string, number>();
	const originalAgent = https.globalAgent;

	beforeAll(async () => {
		const config = path.join(directory, "openssl.cnf");
		const keyPath = path.join(directory, "key.pem");
		const certPath = path.join(directory, "cert.pem");
		writeFileSync(
			config,
			"[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n",
		);
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-config",
				config,
				"-keyout",
				keyPath,
				"-out",
				certPath,
			],
			{ stdio: "ignore" },
		);
		const cert = readFileSync(certPath);
		// The certificate is trusted the way a system CA is: through the agent
		// that node:https uses when the request names none.
		https.globalAgent = new https.Agent({ ca: cert });
		const echo: http.RequestListener = (req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					host: req.headers.host ?? null,
					servername: (req.socket as TLSSocket).servername || null,
				}),
			);
		};
		const families = hasIpv6Loopback ? ["127.0.0.1", "::1"] : ["127.0.0.1"];
		for (const scheme of SCHEMES) {
			for (const address of families) {
				const server =
					scheme === "https"
						? https.createServer({ key: readFileSync(keyPath), cert }, echo)
						: http.createServer(echo);
				await new Promise<void>((resolve) =>
					server.listen(0, address, resolve),
				);
				const key = `${scheme} ${address}`;
				servers.set(key, server);
				ports.set(key, (server.address() as AddressInfo).port);
			}
		}
	});

	afterAll(async () => {
		https.globalAgent.destroy();
		https.globalAgent = originalAgent;
		await Promise.all(
			[...servers.values()].map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
		);
		rmSync(directory, { recursive: true, force: true });
	});

	for (const modelCase of modelCases) {
		const { hostKind, scheme, sni, hostHeaderBracketed } = modelCase;
		const urlHost = URL_HOSTS[hostKind];
		const address = ADDRESSES[hostKind];
		const protocol = SCHEMES[scheme];
		it.skipIf(hostKind === 2 && !hasIpv6Loopback)(
			`matches the generated pinned transport outcome for ${protocol}://${urlHost}`,
			async () => {
				expect(modelCase.outcome).toBe(0);
				const port = ports.get(`${protocol} ${address}`);
				const result = await fetchWithSsrfGuard({
					url: `${protocol}://${urlHost}:${port}/`,
					// Pins localhost to the IPv4 server; a literal pins to itself.
					lookupFn: async () => [
						{ address, family: address.includes(":") ? 6 : 4 },
					],
					pinnedFetchImpl: nodePinnedFetch,
					policy: { allowPrivateNetwork: true },
					timeoutMs: 5000,
				});
				try {
					expect(result.response.status).toBe(200);
					const seen = (await result.response.json()) as {
						host: string | null;
						servername: string | null;
					};
					expect(seen.host).toBe(`${urlHost}:${port}`);
					expect(seen.host?.startsWith("[")).toBe(hostHeaderBracketed);
					// SNI carries DNS names only (RFC 6066); Node checks an IP
					// literal against the certificate's IP addresses.
					expect(seen.servername).toBe(sni === 1 ? urlHost : null);
				} finally {
					await result.release();
				}
			},
		);
	}
});
