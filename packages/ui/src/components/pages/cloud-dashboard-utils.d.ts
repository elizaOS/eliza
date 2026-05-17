import type {
  CloudBillingCheckoutResponse,
  CloudBillingSettings,
  CloudBillingSummary,
  CloudCompatAgent,
} from "../../api";
export declare const ELIZA_CLOUD_INSTANCES_URL =
  "https://www.elizacloud.ai/dashboard/app";
/** Marketing / docs site — "Learn more" when not connected (in-app browser on desktop). */
export declare const ELIZA_CLOUD_WEB_URL = "https://elizacloud.ai";
export declare const BILLING_PRESET_AMOUNTS: number[];
export declare const MANAGED_DISCORD_GATEWAY_AGENT_NAME = "Discord Gateway";
export declare const STATUS_BADGE: Record<
  string,
  {
    i18nKey: string;
    className: string;
  }
>;
export declare function getCloudAuthToken(): string;
export declare function isRecord(
  value: unknown,
): value is Record<string, unknown>;
export declare function resolveCloudAccountIdDisplay(
  userId: string | null,
  statusReason: string | null,
  t: (key: string) => string,
): {
  mono: boolean;
  text: string;
};
export declare function unwrapBillingData<T extends Record<string, unknown>>(
  value: T,
): T;
export declare function readString(value: unknown): string | undefined;
export declare function readNumber(value: unknown): number | null;
export declare function readBoolean(value: unknown): boolean | undefined;
export interface ManagedDiscordCallbackState {
  status: "connected" | "error";
  agentId: string | null;
  guildId: string | null;
  guildName: string | null;
  managed: boolean;
  message: string | null;
  restarted: boolean;
}
export declare function consumeManagedDiscordCallbackUrl(rawUrl: string): {
  callback: ManagedDiscordCallbackState | null;
  cleanedUrl: string | null;
};
export declare function buildManagedDiscordSettingsReturnUrl(
  rawUrl: string,
): string | null;
export declare function resolveManagedDiscordAgentChoice(
  agents: CloudCompatAgent[],
):
  | {
      mode: "none";
      agent: null;
      selectedAgentId: null;
    }
  | {
      mode: "bootstrap";
      agent: null;
      selectedAgentId: null;
    }
  | {
      mode: "direct";
      agent: CloudCompatAgent;
      selectedAgentId: string;
    }
  | {
      mode: "picker";
      agent: null;
      selectedAgentId: string;
    };
export declare function isManagedDiscordGatewayAgent(
  agent: CloudCompatAgent,
): boolean;
export interface ManagedGithubCallbackState {
  status: "connected" | "error";
  connectionId: string | null;
  agentId: string | null;
  message: string | null;
}
export declare function consumeManagedGithubCallbackUrl(rawUrl: string): {
  callback: ManagedGithubCallbackState | null;
  cleanedUrl: string | null;
};
export declare function normalizeBillingSummary(
  raw: CloudBillingSummary,
): CloudBillingSummary;
export declare function normalizeBillingSettings(
  raw: CloudBillingSettings,
): CloudBillingSettings;
export declare function getBillingAutoTopUp(
  settings: CloudBillingSettings | null,
): Record<string, unknown>;
export declare function getBillingLimits(
  settings: CloudBillingSettings | null,
): Record<string, unknown>;
export declare function resolveCheckoutUrl(
  response: CloudBillingCheckoutResponse,
): string | null;
export interface AutoTopUpFormState {
  amount: string;
  dirty: boolean;
  enabled: boolean;
  sourceKey: string;
  threshold: string;
}
export type AutoTopUpFormAction =
  | {
      type: "hydrate";
      next: AutoTopUpFormState;
      force?: boolean;
    }
  | {
      type: "setAmount";
      value: string;
    }
  | {
      type: "setEnabled";
      value: boolean;
    }
  | {
      type: "setThreshold";
      value: string;
    };
export declare function buildAutoTopUpFormState(
  billingSummary: CloudBillingSummary | null,
  billingSettings: CloudBillingSettings | null,
): AutoTopUpFormState;
export declare function autoTopUpFormReducer(
  state: AutoTopUpFormState,
  action: AutoTopUpFormAction,
): AutoTopUpFormState;
//# sourceMappingURL=cloud-dashboard-utils.d.ts.map
