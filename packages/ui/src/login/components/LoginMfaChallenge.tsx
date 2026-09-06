/** Collects the factor required to complete a pending login challenge. */
import { type FormEvent, useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAuth } from "../hooks/useAuth.js";
import type { LoginMfaChallengeProps } from "../types.js";

export function LoginMfaChallenge({
  challenge,
  onSuccess,
  onError,
  allowRecoveryCode = true,
  className,
}: LoginMfaChallengeProps) {
  const auth = useAuth();
  const codeId = useId();
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const trimmed = code.trim();
      const result =
        mode === "recovery"
          ? await auth.completeRecoveryCodeMfa(challenge.challengeId, trimmed)
          : challenge.type === "sms"
            ? await auth.completeSmsMfa(challenge.challengeId, trimmed)
            : await auth.completeTotpMfa(challenge.challengeId, trimmed);
      onSuccess?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setMessage(error.message);
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }

  async function completePasskey() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await auth.completePasskeyMfa();
      onSuccess?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setMessage(error.message);
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }

  if (challenge.type === "passkey") {
    return (
      <div
        className={["stwd-mfa-challenge", className].filter(Boolean).join(" ")}
      >
        <div className="stwd-mfa-challenge__header">
          <h3>multi-factor verification</h3>
        </div>
        <Button
          type="button"
          className="stwd-mfa-primary"
          disabled={busy}
          onClick={() => void completePasskey()}
        >
          {busy ? "verifying..." : "verify with passkey"}
        </Button>
        {message && <div className="stwd-mfa-error">{message}</div>}
      </div>
    );
  }

  const inputMode = mode === "recovery" ? "text" : "numeric";
  const pattern = mode === "recovery" ? undefined : "[0-9]*";
  const label =
    mode === "recovery" ? "recovery code" : `${challenge.type} code`;

  return (
    <form
      className={["stwd-mfa-challenge", className].filter(Boolean).join(" ")}
      onSubmit={submit}
    >
      <div className="stwd-mfa-challenge__header">
        <h3>multi-factor verification</h3>
      </div>
      <label className="stwd-mfa-field" htmlFor={codeId}>
        <span>{label}</span>
        <Input
          id={codeId}
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
          autoComplete="one-time-code"
          inputMode={inputMode}
          pattern={pattern}
          required
        />
      </label>
      {allowRecoveryCode && challenge.type === "totp" && (
        <Button
          type="button"
          className="stwd-mfa-link"
          onClick={() => {
            setCode("");
            setMode((current) =>
              current === "recovery" ? "code" : "recovery",
            );
          }}
        >
          {mode === "recovery" ? "use authenticator code" : "use recovery code"}
        </Button>
      )}
      {message && <div className="stwd-mfa-error">{message}</div>}
      <Button type="submit" className="stwd-mfa-primary" disabled={busy}>
        {busy ? "verifying..." : "verify"}
      </Button>
    </form>
  );
}
