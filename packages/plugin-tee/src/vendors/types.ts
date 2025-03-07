import type { Action, Provider } from "@elizaos/core";

export const TeeVendorNames = {
	PHALA: "phala",
	SGX_GRAMINE: "sgx_gramine",
} as const;

export type TeeVendorName =
	| (typeof TeeVendorNames)[keyof typeof TeeVendorNames]
	| string;

export interface TeeVendor {
	type: TeeVendorName;
	getActions(): Action[];
	getProviders(): Provider[];
	getName(): string;
	getDescription(): string;
}
