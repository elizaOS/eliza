/** Builds the bounded TwiML documents that attach Twilio calls to Eliza. */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const ELIZA_AI_CALL_DISCLOSURE =
  "Hi, this is Eliza, your AI assistant. This call uses an AI-generated voice.";

export function buildTerminalVoiceTwiML(prompt: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(prompt)}</Say></Response>`;
}

export function buildRealtimeVoiceTwiML(options: {
  streamUrl: string;
  sessionId: string;
  token: string;
  disclosure: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(options.disclosure)}</Say><Connect><Stream url="${escapeXml(options.streamUrl)}"><Parameter name="sessionId" value="${escapeXml(options.sessionId)}"/><Parameter name="token" value="${escapeXml(options.token)}"/></Stream></Connect></Response>`;
}
