import { Suspense } from "react";
import { CliLoginContent, CliLoginFallback } from "./cli-login-content";

/**
 * CLI login page for authenticating command-line tool users.
 * Handles Privy authentication and generates API keys for CLI access.
 */
export default function CliLoginPage() {
  return (
    <Suspense fallback={<CliLoginFallback />}>
      <CliLoginContent />
    </Suspense>
  );
}
