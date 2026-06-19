import type { Action, Provider } from "@elizaos/core";
import {
  phalaDeriveKeyProvider,
  phalaRemoteAttestationProvider,
} from "../providers";
import { type TeeVendorInterface, TeeVendorNames } from "./types";

export class PhalaVendor implements TeeVendorInterface {
  readonly type = TeeVendorNames.PHALA;

  getActions(): Action[] {
    return [];
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
