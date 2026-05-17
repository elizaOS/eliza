import type { CloudSetupSessionService } from "@elizaos/cloud-sdk/cloud-setup-session";
export interface CloudProvisioningProgress {
  status: "chat" | "provisioning" | "running" | "error";
  meta: string;
  ready: boolean;
}
export interface StateCloudChatProps {
  transcript?: string;
  progress?: CloudProvisioningProgress;
  onEnterChat: () => void;
  /** When provided, the live setup-agent transcript is rendered via `useCloudSetupSession`. */
  service?: CloudSetupSessionService;
  tenantId?: string;
}
export declare function StateCloudChat(
  props: StateCloudChatProps,
): React.JSX.Element;
//# sourceMappingURL=StateCloudChat.d.ts.map
