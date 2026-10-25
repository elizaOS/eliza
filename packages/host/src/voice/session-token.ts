/** Authentication-neutral scope supplied by an admitting host. */
export interface VoiceSessionTokenClaims {
  sessionId: string;
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId: string;
}
export type VoiceTokenVerifier = (
  token: string,
  expected: Partial<VoiceSessionTokenClaims>,
  options?: { now?: () => number },
) => Promise<{
  claims: VoiceSessionTokenClaims;
  jti: string;
  expSeconds: number;
}>;
