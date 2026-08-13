/** Builds the bounded TwiML documents that attach Twilio calls to Eliza. */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildTerminalVoiceTwiML(prompt: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(prompt)}</Say></Response>`;
}

export function buildRealtimeVoiceTwiML(options: {
  streamUrl: string;
  calledNumber: string;
  conversationId: string;
  greeting: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(options.greeting)}</Say><Connect><Stream url="${escapeXml(options.streamUrl)}"><Parameter name="calledNumber" value="${escapeXml(options.calledNumber)}"/><Parameter name="conversationId" value="${escapeXml(options.conversationId)}"/></Stream></Connect></Response>`;
}
