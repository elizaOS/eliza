/**
 * Validate JWT issuer against whitelist.
 *
 * When JWT_ISSUER_WHITELIST is configured (and not '*'), validation is mandatory.
 * Throws an error if the issuer is not in the whitelist.
 *
 * @param issuer - The issuer claim from the JWT payload
 * @throws Error if issuer is not whitelisted
 */
export function validateIssuer(issuer: string | undefined): void {
  const issuerWhitelist = process.env.JWT_ISSUER_WHITELIST;

  // No whitelist configured - skip validation
  if (!issuerWhitelist) {
    return;
  }

  // Wildcard - allow all issuers
  if (issuerWhitelist === '*') {
    return;
  }

  // Whitelist configured - validation is mandatory
  const allowedIssuers = issuerWhitelist.split(',').map((iss) => iss.trim());

  if (!issuer) {
    throw new Error('JWT missing required claim: iss (issuer whitelist is configured)');
  }

  if (!allowedIssuers.includes(issuer)) {
    throw new Error(`Untrusted issuer: ${issuer}`);
  }
}
