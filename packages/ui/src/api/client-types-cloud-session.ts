/** Native account status shared with lightweight browser hosts. */
export interface CloudStatus {
  /** Older servers omit this field; omission must remain visibly unavailable. */
  applicationBilling?: import("@elizaos/cloud-sdk/app-billing").NativeApplicationBillingSelection;
  connected: boolean;
  enabled?: boolean;
  cloudVoiceProxyAvailable?: boolean;
  hasApiKey?: boolean;
  userId?: string;
  organizationId?: string;
  topUpUrl?: string;
  reason?: string;
}
export interface CloudCredits {
  connected: boolean;
  balance: number | null;
  /** True when the cloud API rejected the stored API key (same as chat 401). */
  authRejected?: boolean;
  error?: string;
  low?: boolean;
  critical?: boolean;
  topUpUrl?: string;
}
