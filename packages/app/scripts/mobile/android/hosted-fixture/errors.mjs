/** A disposable fixture could not be admitted or qualified from observed state. */
export class HostedFixtureError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostedFixtureError";
  }
}
