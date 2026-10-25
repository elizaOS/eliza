/**
 * The resolved unauthenticated surface for an agent runtime.
 *
 * Managed Cloud targets receive the classified Cloud recovery surface
 * (reauth, retry, or management); self-hosted runtimes retain their
 * owner-password form. Keeping this choice in one rendered seam makes it
 * impossible for the native fallback to accidentally mount both.
 */
import type { AgentSessionUnauthReason } from "../../state/agent-session-recovery";
import { CloudHostedAgentAuthNotice } from "./CloudPairRelay";
import { LoginView } from "./LoginView";

export interface AgentAuthGateSurfaceProps {
  showCloudReauth: boolean;
  onNativeReauth?: () => Promise<void>;
  onNativeRetry?: () => Promise<void>;
  nativeRecoveryMode?: "reauth" | "retry" | "manage";
  onLoginSuccess: () => void;
  reason: AgentSessionUnauthReason;
}

export function AgentAuthGateSurface({
  showCloudReauth,
  onNativeReauth,
  onNativeRetry,
  nativeRecoveryMode,
  onLoginSuccess,
  reason,
}: AgentAuthGateSurfaceProps) {
  if (showCloudReauth) {
    return (
      <CloudHostedAgentAuthNotice
        nativeRecoveryMode={nativeRecoveryMode}
        onNativeReauth={onNativeReauth}
        onNativeRetry={onNativeRetry}
      />
    );
  }

  return <LoginView onLoginSuccess={onLoginSuccess} reason={reason} />;
}
