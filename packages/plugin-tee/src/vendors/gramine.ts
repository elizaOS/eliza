import { sgxAttestationProvider } from "../providers/remoteAttestationProvider";
import type { TeeVendor } from "./types";
import { TeeVendorNames } from "./types";

export class GramineVendor implements TeeVendor {
	type = TeeVendorNames.SGX_GRAMINE;

	getActions() {
		return [];
	}

	getProviders() {
		return [sgxAttestationProvider];
	}

	getName() {
		return "sgx-gramine-plugin";
	}

	getDescription() {
		return "SGX Gramine TEE to Host Eliza Agents";
	}
}
