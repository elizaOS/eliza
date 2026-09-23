/** Defines app-owned team synchronization without granting backend clients purchase or administrator authority. */
export interface AppBillingMember {
  userId: string;
  role: "administrator" | "member";
  active: boolean;
}
export interface AppBillingMembershipSnapshot {
  appId: string;
  billingAccountId: string;
  environment: "test" | "live";
  revision: string;
  members: AppBillingMember[];
}
export interface SynchronizeAppBillingMemberRequest {
  userId: string;
  active: boolean;
  expectedRevision: string;
  idempotencyKey: string;
  /** The app determines which product roles use seats; removing membership revokes all seats in this environment. */
  seats: { productFamilyKey: string; assigned: boolean }[];
}
export interface AppBillingMembershipChange {
  appId: string;
  billingAccountId: string;
  environment: "test" | "live";
  revision: string;
  member: AppBillingMember;
  seats: { productFamilyKey: string; seatId: string }[];
}

/** Purchaser-authorized role changes retain ordinary membership, seats and trial history. */
export interface ChangeAppBillingAdministratorRequest {
  action: "grant" | "revoke" | "transfer";
  userId: string;
  expectedRevision: string;
  idempotencyKey: string;
}
export interface AppBillingAdministratorsSnapshot {
  appId: string;
  billingAccountId: string;
  environment: "test" | "live";
  revision: string;
  administrators: string[];
}
