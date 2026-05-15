/**
 * Typed error classes for authentication/authorization failures.
 * Used by requireAdmin and route error handlers for robust status mapping.
 */

export class WalletRequiredError extends Error {
  constructor(message = "Wallet connection required") {
    super(message);
    this.name = "WalletRequiredError";
  }
}

export class AdminRequiredError extends Error {
  constructor(message = "Admin access required") {
    super(message);
    this.name = "AdminRequiredError";
  }
}
