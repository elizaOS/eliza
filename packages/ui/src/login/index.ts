/** Exposes login state, account linking, MFA and recovery components to React hosts. */

export { LoginAuthGuard } from "./components/LoginAuthGuard.js";
export { LoginEmailCallback } from "./components/LoginEmailCallback.js";
export {
  LoginForm,
  PASSKEY_ENROLL_PROMPT_KEY,
} from "./components/LoginForm.js";
export { LoginLinkedAccounts } from "./components/LoginLinkedAccounts.js";
export { LoginMfaChallenge } from "./components/LoginMfaChallenge.js";
export { LoginMfaSettings } from "./components/LoginMfaSettings.js";
export { LoginOAuthCallback } from "./components/LoginOAuthCallback.js";
export { LoginTenantPicker } from "./components/LoginTenantPicker.js";
export { LoginUserButton } from "./components/LoginUserButton.js";
export { PasskeyEnrollmentPrompt } from "./components/PasskeyEnrollmentPrompt.js";
export { useAuth } from "./hooks/useAuth.js";
export { useLogin } from "./hooks/useLogin.js";
export { useMfaStepUp } from "./hooks/useMfaStepUp.js";
export { DiscordIcon, GoogleIcon } from "./icons/index.js";
export type { LoginProviderWithAuthProps } from "./provider.js";
export { LoginProvider } from "./provider.js";
export type {
  LoginAuthConfig,
  LoginAuthContextValue,
  LoginAuthGuardProps,
  LoginContextValue,
  LoginEmailCallbackProps,
  LoginFormProps,
  LoginLinkedAccountsProps,
  LoginMfaChallengeProps,
  LoginMfaSettingsProps,
  LoginOAuthCallbackProps,
  LoginProviderProps,
  LoginTenantPickerProps,
  LoginUserButtonProps,
  TenantTheme,
} from "./types.js";
