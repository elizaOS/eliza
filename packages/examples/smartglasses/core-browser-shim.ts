export const logger = {
  debug: console.debug.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
};

export class Service {
  static serviceType = "service";
  capabilityDescription = "";

  constructor(_runtime?: unknown) {}

  async stop(): Promise<void> {}
}

export function parseJSONObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
