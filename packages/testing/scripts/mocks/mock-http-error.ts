/** Runs the mock http error mock-service support script for deterministic local test fixtures. */
export class MockHttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
