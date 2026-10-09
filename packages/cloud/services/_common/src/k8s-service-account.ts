/** Reads the current projected credentials, including Kubernetes token rotation. */
import { readFileSync } from "node:fs";

const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_CERT_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

export class ServiceAccountCredentialError extends Error {
  readonly code = "SERVICE_ACCOUNT_CREDENTIAL_READ_FAILED";

  constructor(cause: unknown) {
    super("Could not read Kubernetes service-account credentials", { cause });
    this.name = "ServiceAccountCredentialError";
  }
}

function readCredential(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Local hosts need no service account. Other I/O failures must not look
    // like an intentional absence, and neither result is cached.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new ServiceAccountCredentialError(error);
  }
}

export function readServiceAccountToken(path = TOKEN_PATH): string | null {
  return readCredential(path);
}

export function readServiceAccountCaCert(path = CA_CERT_PATH): string | null {
  return readCredential(path);
}
