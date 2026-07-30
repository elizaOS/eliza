/**
 * Browser-barrel contract for delivery-audience evidence: clients may inspect
 * decisions but cannot import either server attestor or mutation authority.
 */
import { describe, expect, it } from "vitest";
import * as browserCore from "./index.browser";

describe("browser delivery-audience exports", () => {
	it("does not expose trusted audience attestors or mutation APIs", () => {
		const exported = browserCore as Record<string, unknown>;
		expect(exported.attestDeliveryAudienceFromCanonicalRoom).toBeUndefined();
		expect(exported.attestAuthenticatedApiDeliveryAudience).toBeUndefined();
		expect(exported.authorizeOwnerExclusiveDisclosure).toBeUndefined();
		expect(exported.markOwnerExclusiveDisclosureUsed).toBeUndefined();
		expect(exported.revalidateOwnerExclusiveDisclosure).toBeUndefined();
		expect(exported.evaluateOwnerExclusiveDisclosure).toBeTypeOf("function");
	});
});
