/** Test-only loader that simulates a production image without googleapis. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "googleapis" || specifier.startsWith("googleapis/")) {
    throw new Error("googleapis must not be evaluated while Calendar boots");
  }
  return nextResolve(specifier, context);
}
