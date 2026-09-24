/** Runs the mock http error mock-service support script for deterministic local test fixtures. */
export class MockHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
