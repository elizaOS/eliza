import type { Action, Provider } from "@elizaos/core";
import { remoteAttestationAction } from "../actions/remoteAttestation";
import { phalaDeriveKeyProvider, phalaRemoteAttestationProvider } from "../providers";
import { type TeeVendorInterface, TeeVendorNames } from "./types";

export class PhalaVendor implements TeeVendorInterface {
  readonly type = TeeVendorNames.PHALA;

  getActions(): Action[] {
    return [remoteAttestationAction];
  }

  getProviders(): Provider[] {
    return [phalaDeriveKeyProvider, phalaRemoteAttestationProvider];
  }

  getName(): string {
    return "phala-tee-plugin";
  }

  getDescription(): string {
    return "Phala Network TEE for secure agent execution";
  }
}
