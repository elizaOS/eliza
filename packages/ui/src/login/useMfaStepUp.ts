/** Exposes session step-up operations and the current MFA verification state. */
import { isLoginMfaRequiredError } from "@elizaos/auth";
import { useCallback } from "react";
import { useAuth } from "./useAuth.js";

export interface MfaStepUpState {
  mfaVerifiedAt: number | null;
  mfaMethod: string | null;
  factorEnrollmentVerifiedAt: number | null;
}

export interface UseMfaStepUpResult {
  state: MfaStepUpState;
  isMfaRequiredError: typeof isLoginMfaRequiredError;
  stepUpWithTotp: (
    code: string,
  ) => Promise<import("@elizaos/auth").LoginAuthResult>;
  stepUpWithRecoveryCode: (
    recoveryCode: string,
  ) => Promise<import("@elizaos/auth").LoginAuthResult>;
  sendSmsCode: () => Promise<import("@elizaos/auth").LoginSmsMfaEnrollResult>;
  stepUpWithSms: (
    code: string,
  ) => Promise<import("@elizaos/auth").LoginAuthResult>;
  stepUpWithPasskey: () => Promise<import("@elizaos/auth").LoginAuthResult>;
}

/**
 * Current-session MFA step-up helpers for sensitive actions.
 */
export function useMfaStepUp(): UseMfaStepUpResult {
  const auth = useAuth();

  const stepUpWithTotp = useCallback(
    async (code: string) => {
      return auth.stepUpWithTotp(code);
    },
    [auth],
  );

  const stepUpWithRecoveryCode = useCallback(
    async (recoveryCode: string) => {
      return auth.stepUpWithRecoveryCode(recoveryCode);
    },
    [auth],
  );

  const sendSmsCode = useCallback(async () => {
    return auth.sendSmsMfaCode();
  }, [auth]);

  const stepUpWithSms = useCallback(
    async (code: string) => {
      return auth.stepUpWithSms(code);
    },
    [auth],
  );

  const stepUpWithPasskey = useCallback(async () => {
    return auth.completePasskeyMfa();
  }, [auth]);

  return {
    state: {
      mfaVerifiedAt: auth.session?.mfaVerifiedAt ?? null,
      mfaMethod: auth.session?.mfaMethod ?? null,
      factorEnrollmentVerifiedAt:
        auth.session?.factorEnrollmentVerifiedAt ?? null,
    },
    isMfaRequiredError: isLoginMfaRequiredError,
    stepUpWithTotp,
    stepUpWithRecoveryCode,
    sendSmsCode,
    stepUpWithSms,
    stepUpWithPasskey,
  };
}
