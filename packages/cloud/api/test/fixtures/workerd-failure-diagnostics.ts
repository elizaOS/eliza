/** Transfers fixture failure details to a private test binding without changing the original outcome. */
export interface FailureDiagnosticBinding {
  fetch(request: Request): Promise<Response>;
}

export async function withWorkerdFailureDiagnostics<T>(
  operation: () => Promise<T>,
  diagnostics: FailureDiagnosticBinding,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // error-policy:J2 The fixture retains its original exception across diagnostic collection.
    try {
      const causes = [];
      const seen = new Set<Error>();
      let current: unknown = error;
      let cyclicCause = false;
      do {
        if (current instanceof Error && seen.has(current)) {
          cyclicCause = true;
          break;
        }
        if (!(current instanceof Error)) {
          causes.push({
            kind: "non-error",
            name: null,
            message: null,
            stack: null,
            code: null,
            failureName: null,
            retryable: null,
          });
          break;
        }
        seen.add(current);
        causes.push({
          kind: "error",
          name: current.name,
          message: current.message,
          stack: current.stack ?? null,
          code:
            "code" in current &&
            (typeof current.code === "string" ||
              (typeof current.code === "number" &&
                Number.isFinite(current.code)))
              ? current.code
              : null,
          failureName:
            "failureName" in current && typeof current.failureName === "string"
              ? current.failureName
              : null,
          retryable:
            "retryable" in current && typeof current.retryable === "boolean"
              ? current.retryable
              : null,
        });
        current = current.cause;
      } while (current !== undefined);
      const receipt = await diagnostics.fetch(
        new Request("https://private-test-diagnostics.invalid/failure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schema: 1, causes, cyclicCause }),
        }),
      );
      if (!receipt.ok)
        throw new Error("Private diagnostic sink rejected the receipt");
    } catch {
      // error-policy:J7 A test diagnostic failure cannot replace the observed runtime failure.
      console.warn("[workerd-fixture-diagnostics] private capture failed");
    }
    throw error;
  }
}
