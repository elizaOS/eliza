// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"; spec/cloud/deployment.md, "A Worker serves only after the server's own start checks pass and its bindings agree with its profile"
import type { Client } from "pg";
import { secrets, testProfile } from "./profile.ts";

export interface WorkerDeployment {
  readonly api: string;
  readonly web: string;
  readonly digest: string;
  readonly fakeUrl?: string;
}

export interface BoundRegistration {
  readonly clientId: string;
  readonly environment: string;
  readonly displayName: string;
  readonly androidPackage: string;
  readonly certFingerprints: ReadonlyArray<string>;
  readonly signInReturn: string;
  readonly billingReturn: string;
  readonly connectReturn?: string;
  readonly credentialTtlMs?: number;
  readonly nativeGoogle?: boolean;
  readonly enabled: boolean;
}

const defaultTtlMs = 30 * 86_400_000;

export function workerBindings({ api, web, digest, fakeUrl = "https://fakes.example.test" }: WorkerDeployment) {
  const base = testProfile(fakeUrl);
  const { production, staging } = base.environments;
  const { billing: _unsold, ...unbilled } = staging;
  const profile = {
    ...base,
    environments: {
      production: { ...production, databaseIdentity: digest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) },
      staging: {
        ...unbilled, api, web, databaseIdentity: digest, firstPartyOrigins: [web],
        capabilities: staging.capabilities.filter((capability) => capability !== "billing"),
        mail: production.mail, sms: { kind: "none" },
      },
    },
  };
  return {
    ...secrets,
    CLOUD_PROFILE: JSON.stringify(profile),
    CLOUD_ENVIRONMENT: "staging" as const,
    CLOUD_IDENTITY_DIGEST: digest,
    PUBLIC_API_ORIGIN: api,
    WEB_ORIGIN: web,
  };
}

export async function registerClients(db: Client, registrations: ReadonlyArray<BoundRegistration>): Promise<void> {
  for (const r of registrations) {
    await db.query(
      `INSERT INTO native_clients (client_id, environment, display_name, android_package, cert_fingerprints, sign_in_return, billing_return,
         connect_return, credential_ttl_ms, native_google, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, 1, 1)`,
      [r.clientId, r.environment, r.displayName, r.androidPackage, JSON.stringify(r.certFingerprints), r.signInReturn, r.billingReturn,
        r.connectReturn ?? null, r.credentialTtlMs ?? defaultTtlMs, r.nativeGoogle ?? false, r.enabled],
    );
  }
}
