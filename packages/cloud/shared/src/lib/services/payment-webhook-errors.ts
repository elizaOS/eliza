// Coordinates cloud service payment webhook errors behavior behind route handlers.
export class IgnoredWebhookEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IgnoredWebhookEvent";
  }
}
