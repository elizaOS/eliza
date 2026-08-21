/** Finalizes a SIWS bearer only after the canonical user endpoint accepts it. */

export async function confirmSiwsSession(
  apiKey: string,
  dependencies: {
    storeToken: (token: string | null) => void;
    loadCanonicalUser: (token: string) => Promise<unknown>;
    clearIdentity: () => void;
  },
): Promise<void> {
  try {
    await dependencies.loadCanonicalUser(apiKey);
    dependencies.storeToken(apiKey);
  } catch (error) {
    dependencies.clearIdentity();
    throw error;
  }
}
