/** Describes individual app billing registration without implying configured merchant, trial, subscription or funding authority. */
export type AppBillingEnvironment = "test" | "live";
export interface AppBillingRegistrationDto {
  id: string;
  appId: string;
  environment: AppBillingEnvironment;
  merchant: { state: "unconfigured" };
  policy: { state: "unconfigured" };
}
export type AppBillingAccountDto =
  | { state: "unregistered"; appId: string; environment: AppBillingEnvironment }
  | {
      state: "unconfigured";
      registration: AppBillingRegistrationDto;
      account: { id: string; kind: "individual" };
      subscription: {
        state: "unavailable";
        reason: "merchant_and_policy_unconfigured";
      };
    };
export interface AppBillingAccountResponse {
  success: true;
  data: AppBillingAccountDto;
}
export interface AppBillingRegistrationResponse {
  success: true;
  data: AppBillingRegistrationDto;
}
