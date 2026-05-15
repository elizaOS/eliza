export class IgnoredWebhookEvent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IgnoredWebhookEvent";
  }
}
