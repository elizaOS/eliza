/**
 * Throughput benchmarks for the secret-swap layer (#10469). Run with
 * `bunx vitest bench src/security/secret-swap.bench.ts`. These measure the
 * ingress (detect + substitute) and egress (restore) cost on realistic prompt
 * payloads so a future regex change that tanks performance is caught.
 */
import { bench, describe } from "vitest";
import { detectPii } from "./pii-detectors";
import { SecretSwapSession } from "./secret-swap";

const SECRETS = [
	"4242424242424242", // card
	"ops+oncall@example.com", // email
	"sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", // openai key
	"AKIAIOSFODNN7EXAMPLE", // aws
	"ghp_1234567890abcdefghijklmnopqrstuvwxyz", // github
	"123-45-6789", // ssn
	"GB29NWBK60161331926819", // iban
];
const FILLER =
	"The agent should deploy the service and configure the connector with the provided credentials, then verify the health check passes before reporting status back to the operator. ";

/** Build a ~`kb`-KB document with secrets sprinkled every few sentences. */
function makeDoc(kb: number, withSecrets: boolean): string {
	const target = kb * 1024;
	const parts: string[] = [];
	let size = 0;
	let i = 0;
	while (size < target) {
		parts.push(FILLER);
		size += FILLER.length;
		if (withSecrets && i % 3 === 0) {
			const s = SECRETS[i % SECRETS.length] as string;
			parts.push(`value=${s} `);
			size += s.length + 7;
		}
		i += 1;
	}
	return parts.join("");
}

const cleanDoc = makeDoc(100, false); // ~100KB benign
const denseDoc = makeDoc(50, true); // ~50KB with hundreds of secrets

describe("secret-swap throughput", () => {
	bench("detectPii — 100KB benign (false-positive scan cost)", () => {
		detectPii(cleanDoc);
	});
	bench("detectPii — 50KB secret-dense", () => {
		detectPii(denseDoc);
	});
	bench("substituteText — 50KB secret-dense (ingress)", () => {
		new SecretSwapSession().substituteText(denseDoc);
	});
	bench("substitute + restore round-trip — 50KB secret-dense", () => {
		const session = new SecretSwapSession();
		session.restoreText(session.substituteText(denseDoc), {
			failOnUnresolved: true,
		});
	});
});
