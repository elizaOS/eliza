import type { TeeVendor } from "./types";
import { phalaRemoteAttestationProvider as remoteAttestationProvider } from "../providers/remoteAttestationProvider";
import { phalaDeriveKeyProvider as deriveKeyProvider } from "../providers/deriveKeyProvider";
import { phalaRemoteAttestationAction as remoteAttestationAction } from "../actions/remoteAttestationAction";
import { TeeVendors } from "@elizaos/core";

export class PhalaVendor implements TeeVendor {
	type = TeeVendors.PHALA;

	getActions() {
		return [remoteAttestationAction];
	}
	getProviders() {
		return [deriveKeyProvider, remoteAttestationProvider];
	}

	getName() {
		return "phala-tee-plugin";
	}

	getDescription() {
		return "Phala TEE Cloud to Host Eliza Agents";
	}
}
