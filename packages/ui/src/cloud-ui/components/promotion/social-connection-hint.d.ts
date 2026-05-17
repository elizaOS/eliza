interface ConnectionStatus {
  discord: {
    configured: boolean;
    connected: boolean;
    guildCount?: number;
  };
  telegram: {
    configured: boolean;
    connected: boolean;
    botUsername?: string;
  };
}
interface AutomationStatus {
  discord: {
    enabled: boolean;
    ready: boolean;
  };
  telegram: {
    enabled: boolean;
    ready: boolean;
  };
}
interface SocialConnectionHintProps {
  connectionStatus: ConnectionStatus;
  automationStatus: AutomationStatus;
}
export declare function SocialConnectionHint({
  connectionStatus,
  automationStatus,
}: SocialConnectionHintProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=social-connection-hint.d.ts.map
