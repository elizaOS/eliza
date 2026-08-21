/** Finalizes a SIWS bearer only after the canonical user endpoint accepts it. */

export async function confirmSiwsSession(
  apiKey: string,
  dependencies: {
    storeToken: (token: string | null) => void;
    loadCanonicalUser: (token: string) => Promise<unknown>;
    clearIdentity: () => void;
  },
): Promise<void> {
  dependencies.storeToken(apiKey);
  try {
    await dependencies.loadCanonicalUser(apiKey);
  } catch (error) {
    dependencies.storeToken(null);
    dependencies.clearIdentity();
    throw error;
  }
}
