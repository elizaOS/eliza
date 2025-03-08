import type { TeeVendor } from "./types";
import { phalaRemoteAttestationProvider as remoteAttestationProvider } from "../providers/remoteAttestationProvider";
import { phalaDeriveKeyProvider as deriveKeyProvider } from "../providers/deriveKeyProvider";
import { phalaRemoteAttestationAction as remoteAttestationAction } from "../actions/remoteAttestationAction";
import { TeeVendors } from "@elizaos/core";

/**
 * A class representing a vendor for Phala TEE.
 * * @implements { TeeVendor }
 * @type {TeeVendors.PHALA}
 *//**
 * Get the actions for the PhalaVendor.
 * * @returns { Array } An array of actions.
 *//**
 * Get the providers for the PhalaVendor.
 * * @returns { Array } An array of providers.
 *//**
 * Get the name of the PhalaVendor.
 * * @returns { string } The name of the vendor.
 *//**
 * Get the description of the PhalaVendor.
 * * @returns { string } The description of the vendor.
 */
export class PhalaVendor implements TeeVendor {
	type = TeeVendors.PHALA;

	/**
	 * Returns an array of actions.
	 *
	 * @returns {Array} An array containing the remote attestation action.
	 */
	getActions() {
		return [remoteAttestationAction];
	}
	/**
	 * Retrieve the list of providers.
	 *
	 * @returns {Array<Function>} An array containing two provider functions: deriveKeyProvider and remoteAttestationProvider.
	 */
	getProviders() {
		return [deriveKeyProvider, remoteAttestationProvider];
	}

	/**
	 * Returns the name of the plugin.
	 * @returns {string} The name of the plugin.
	 */
	getName() {
		return "phala-tee-plugin";
	}

	/**
	 * Get the description of the function
	 * @returns {string} The description of the function
	 */
	getDescription() {
		return "Phala TEE Cloud to Host Eliza Agents";
	}
}
