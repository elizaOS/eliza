// spec/cloud/identity/requestAuth.md, "Story: Admit a request only for a live credential of an active account"
import { accessLifetime, parseState as parseFamily, refreshLifetime, type Family, type Moment } from "../../gen/cloud__identity__sessions.ts"
import { parseState as parseGrant, type Grant, type GrantPhase } from "../../gen/cloud__nativeClients__deviceKeys.ts"
import { maxCredentialTtl, minCredentialTtl } from "../../gen/cloud__nativeClients__registry.ts"

export type GrantPhaseColumn = "active" | "exchanged" | "expired" | "ended"

export interface GrantShape {
  readonly credentialId: string
  readonly issuedAt: number
  readonly keyExpiresAt: number
  readonly phase?: GrantPhaseColumn
  readonly epoch?: number
}

export interface FamilyShape {
  readonly authAt: number
  readonly accessExpiresAt: number
  readonly live?: boolean
  readonly epoch?: number
  readonly stepUpAt?: number
  readonly mfaAt?: number
}

function grantPhase(column: GrantPhaseColumn, ackedAt: number, keyExpiresAt: number): GrantPhase {
  switch (column) {
    case "active": return { tag: "Active", ackedAt, keyExpiresAt }
    case "exchanged": return { tag: "Exchanged" }
    case "expired": return { tag: "Expired" }
    case "ended": return { tag: "Ended", endedBy: "SelfRevoked" }
  }
}

export function grantState(shape: GrantShape): string {
  const credentialTtl = Math.min(maxCredentialTtl, Math.max(minCredentialTtl, shape.keyExpiresAt - shape.issuedAt))
  const ackedAt = shape.keyExpiresAt - credentialTtl
  const grant: Grant = {
    phase: grantPhase(shape.phase ?? "active", ackedAt, shape.keyExpiresAt),
    origin: { tag: "Connected" },
    codeExpiresAt: ackedAt + 1,
    credentialTtl,
    credentialId: shape.credentialId,
    epoch: shape.epoch ?? 0,
    now: ackedAt
  }
  if (parseGrant(grant) === undefined) throw new Error(`not a device grant state: ${JSON.stringify(grant)}`)
  return JSON.stringify(grant)
}

function at(ms: number | undefined): Moment {
  return ms === undefined || ms === 0 ? { tag: "Never" } : { tag: "At", ms }
}

export function familyState(shape: FamilyShape): Family {
  const issuedAt = Math.max(shape.authAt, shape.accessExpiresAt - accessLifetime)
  const epoch = shape.epoch ?? 0
  const family: Family = {
    phase: shape.live === false ? "Revoked" : "Live",
    generation: 1,
    epoch,
    seenEpoch: epoch,
    authAt: shape.authAt,
    issuedAt,
    accessExpiresAt: shape.accessExpiresAt,
    refreshExpiresAt: shape.authAt + refreshLifetime,
    stepUpAt: at(shape.stepUpAt),
    mfaAt: at(shape.mfaAt),
    now: issuedAt
  }
  if (parseFamily(family) === undefined) throw new Error(`not a session family state: ${JSON.stringify(family)}`)
  return family
}
