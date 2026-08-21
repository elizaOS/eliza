/** Finalizes a SIWS bearer and identity only after the canonical user endpoint accepts it. */

export async function confirmSiwsSession<TCanonicalIdentity>(
  apiKey: string,
  dependencies: {
    loadCanonicalUser: (token: string) => Promise<TCanonicalIdentity>;
    commitSession: (token: string, identity: TCanonicalIdentity) => void;
  },
): Promise<void> {
  const identity = await dependencies.loadCanonicalUser(apiKey);
  dependencies.commitSession(apiKey, identity);
}
