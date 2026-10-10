// Extracted unchanged to keep the Shared runtime import-light.
export class AgentGoogleConnectorError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentGoogleConnectorError";
  }
}
