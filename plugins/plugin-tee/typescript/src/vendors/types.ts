import type { Action, Provider } from "@elizaos/core";

export const TeeVendorNames = {
  PHALA: "phala",
} as const;

export type TeeVendorName = (typeof TeeVendorNames)[keyof typeof TeeVendorNames];

export interface TeeVendorInterface {
  readonly type: TeeVendorName;
  getActions(): Action[];
  getProviders(): Provider[];
  getName(): string;
  getDescription(): string;
}
