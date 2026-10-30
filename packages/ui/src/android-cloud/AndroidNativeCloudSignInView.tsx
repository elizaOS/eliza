/**
 * Eliza's native Android Cloud sign-in screens: an email code, an SMS code or
 * Android's Google account picker, with a second factor when the account has
 * one. The native host (`ElizaCloudSignInPlugin`) does every request and keeps
 * every secret; this view only collects the address, number and codes, calls
 * the port and parses each answer before acting on it.
 */

import {
  NativeCloudSignInError,
  type NativeCloudSignInMfaRequired,
  type NativeCloudSignInReadiness,
  nativeSignInCodeStarted,
  nativeSignInGoogleOutcome,
  nativeSignInReadiness,
  nativeSignInVerified,
  normalizeNativeSignInCode,
  validNativeSignInEmail,
  validNativeSignInPhone,
} from "@elizaos/auth/auth/native-cloud-sign-in";
import { Cloud } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useAppSelector } from "../state/app-store";
import {
  type AndroidNativeCloudSignInRequest,
  abandonAndroidNativeCloudSignIn,
  androidNativeCloudSignInMessage,
  androidNativeCloudSignInPort,
  completeAndroidNativeCloudSignIn,
  type ElizaCloudEnvironment,
  type ElizaNativeCloudSignInPort,
  getAndroidNativeCloudSignInRequest,
  removeListenerHandle,
  subscribeAndroidNativeCloudSignInRequest,
} from "./native-cloud-sign-in";

type Step =
  | { kind: "methods" }
  | {
      kind: "code";
      channel: "email" | "phone";
      attemptId: string;
      destination: string;
      resendAt: number;
    }
  | {
      kind: "mfa";
      attemptId: string;
      method: NativeCloudSignInMfaRequired["method"];
    };

type Readiness = NativeCloudSignInReadiness | null | "loading";

export interface AndroidNativeCloudSignInViewProps {
  request: AndroidNativeCloudSignInRequest;
  /** Defaults to the `ElizaCloudSignIn` native plugin. */
  port?: ElizaNativeCloudSignInPort;
  /** Defaults to settling the shared request broker. */
  onAuthenticated?: (outcome: unknown) => void;
  onAbandon?: (error: NativeCloudSignInError) => void;
}

export function AndroidNativeCloudSignInView({
  request,
  port = androidNativeCloudSignInPort(),
  onAuthenticated = (outcome) =>
    completeAndroidNativeCloudSignIn(request.id, outcome),
  onAbandon = (error) => abandonAndroidNativeCloudSignIn(request.id, error),
}: AndroidNativeCloudSignInViewProps) {
  const t = useAppSelector((state) => state.t);
  const environment: ElizaCloudEnvironment = request.environment;
  const [readiness, setReadiness] = useState<Readiness>("loading");
  const [step, setStep] = useState<Step>({ kind: "methods" });
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const settled = useRef(false);
  // The latest callbacks, without re-subscribing native listeners every render.
  const onAuthenticatedRef = useRef(onAuthenticated);
  const onAbandonRef = useRef(onAbandon);
  onAuthenticatedRef.current = onAuthenticated;
  onAbandonRef.current = onAbandon;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const finish = useCallback((outcome: unknown) => {
    if (settled.current) return;
    settled.current = true;
    onAuthenticatedRef.current(outcome);
  }, []);

  const fail = useCallback((cause: unknown) => {
    const failure = NativeCloudSignInError.from(cause);
    if (!mounted.current) return failure;
    setError(androidNativeCloudSignInMessage(failure));
    // A spent attempt cannot take another code: start over from the methods.
    if (
      failure.code === "expired" ||
      failure.code === "attempts-exhausted" ||
      failure.code === "state-mismatch"
    ) {
      setStep({ kind: "methods" });
      setCode("");
    }
    return failure;
  }, []);

  const loadReadiness = useCallback(
    async (refreshNegative: boolean) => {
      setReadiness("loading");
      try {
        const answer = port.status
          ? await port.status({ environment, refreshNegative })
          : null;
        if (mounted.current) setReadiness(nativeSignInReadiness(answer));
      } catch {
        // error-policy:J4 unknown readiness keeps email and its retry surface.
        if (mounted.current) setReadiness(null);
      }
    },
    [environment, port],
  );

  useEffect(() => {
    void loadReadiness(false);
  }, [loadReadiness]);

  // Resend countdown.
  useEffect(() => {
    if (step.kind !== "code" || step.resendAt <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  // Native announcements: a Google return that completed without a waiting
  // call, one that arrived without a result, and a retained MFA hint.
  useEffect(() => {
    if (!port.addListener) return;
    const handles: unknown[] = [];
    let active = true;
    const keep = (handle: unknown) => {
      if (active) handles.push(handle);
      else void removeListenerHandle(handle);
    };
    void port
      .addListener("signInCompleted", (outcome) => finish(outcome))
      .then(keep, () => {});
    void port
      .addListener("signInIncomplete", (outcome) => {
        fail(
          outcome && typeof outcome === "object"
            ? (outcome as { code?: unknown })
            : outcome,
        );
      })
      .then(keep, () => {});
    void port
      .addListener("signInMfaRequired", (hint) => {
        const attemptId =
          hint && typeof hint === "object"
            ? (hint as { attemptId?: unknown }).attemptId
            : undefined;
        if (typeof attemptId !== "string" || !port.resumeMfa) return;
        void port
          .resumeMfa({ attemptId, environment })
          .then((answer) => {
            const outcome = nativeSignInGoogleOutcome(answer, environment);
            if (outcome.status === "mfa" && mounted.current) {
              setError(null);
              setCode("");
              setStep({
                kind: "mfa",
                attemptId: outcome.attemptId,
                method: outcome.method,
              });
            } else if (outcome.status === "authenticated") finish(outcome);
          })
          .catch(fail);
      })
      .then(keep, () => {});
    return () => {
      active = false;
      for (const handle of handles) void removeListenerHandle(handle);
    };
  }, [environment, fail, finish, port]);

  const run = useCallback(
    async (work: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await work();
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [busy, fail],
  );

  const afterVerification = useCallback(
    (answer: unknown, attemptId: string) => {
      const outcome = nativeSignInVerified(answer, environment);
      if (outcome.status === "authenticated") {
        finish(outcome);
        return;
      }
      setCode("");
      setStep({
        kind: "mfa",
        attemptId: outcome.attemptId ?? attemptId,
        method: outcome.method,
      });
    },
    [environment, finish],
  );

  const startEmail = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!validNativeSignInEmail(address)) {
      fail(new NativeCloudSignInError("invalid-email"));
      return;
    }
    void run(async () => {
      const started = nativeSignInCodeStarted(
        await port.startEmail({ environment, email: address }),
      );
      setCode("");
      setStep({
        kind: "code",
        channel: "email",
        attemptId: started.attemptId,
        destination: address,
        resendAt: started.resendAt,
      });
    });
  };

  const startPhone = (event: FormEvent) => {
    event.preventDefault();
    const number = phone.trim();
    if (!validNativeSignInPhone(number)) {
      fail(new NativeCloudSignInError("invalid-phone"));
      return;
    }
    const startPhoneCode = port.startPhone;
    if (!startPhoneCode) {
      fail(new NativeCloudSignInError("unavailable"));
      return;
    }
    void run(async () => {
      const started = nativeSignInCodeStarted(
        await startPhoneCode.call(port, { environment, phone: number }),
      );
      setCode("");
      setStep({
        kind: "code",
        channel: "phone",
        attemptId: started.attemptId,
        destination: number,
        resendAt: started.resendAt,
      });
    });
  };

  const startGoogle = () => {
    void run(async () => {
      const outcome = nativeSignInGoogleOutcome(
        await port.startGoogle({ environment }),
        environment,
      );
      if (outcome.status === "authenticated") {
        finish(outcome);
        return;
      }
      setCode("");
      setStep({
        kind: "mfa",
        attemptId: outcome.attemptId,
        method: outcome.method,
      });
    });
  };

  const verify = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind === "methods") return;
    const digits = normalizeNativeSignInCode(code);
    if (!digits) {
      fail(new NativeCloudSignInError("invalid-code"));
      return;
    }
    const current = step;
    void run(async () => {
      if (current.kind === "mfa") {
        afterVerification(
          await port.verifyMfa({ attemptId: current.attemptId, code: digits }),
          current.attemptId,
        );
        return;
      }
      if (current.channel === "phone") {
        if (!port.verifyPhone) throw new NativeCloudSignInError("unavailable");
        afterVerification(
          await port.verifyPhone({
            attemptId: current.attemptId,
            code: digits,
          }),
          current.attemptId,
        );
        return;
      }
      afterVerification(
        await port.verifyEmail({ attemptId: current.attemptId, code: digits }),
        current.attemptId,
      );
    });
  };

  const resend = () => {
    if (step.kind !== "code") return;
    const current = step;
    void run(async () => {
      let answer: unknown;
      if (current.channel === "email") {
        answer = await port.startEmail({
          environment,
          email: current.destination,
        });
      } else {
        if (!port.startPhone) throw new NativeCloudSignInError("unavailable");
        answer = await port.startPhone({
          environment,
          phone: current.destination,
        });
      }
      const started = nativeSignInCodeStarted(answer);
      setCode("");
      setStep({
        ...current,
        attemptId: started.attemptId,
        resendAt: started.resendAt,
      });
    });
  };

  const chooseAnotherMethod = () => {
    void port.cancel().catch(() => {
      // error-policy:J4 cancelling an attempt that already ended is a no-op.
    });
    setError(null);
    setCode("");
    setStep({ kind: "methods" });
  };

  const leave = () => {
    if (settled.current) return;
    settled.current = true;
    void port.cancel().catch(() => {
      // error-policy:J4 cancelling an attempt that already ended is a no-op.
    });
    onAbandonRef.current(new NativeCloudSignInError("cancelled"));
  };

  const offers = readiness === "loading" ? null : readiness;
  // Unknown readiness keeps email (and its error/retry surface); a method the
  // host reports as unavailable stays hidden. SMS is never inferred.
  const showEmail =
    readiness !== "loading" && (offers === null || offers.email);
  const showPhone = Boolean(offers?.phone);
  const showGoogle = Boolean(offers?.google);
  const nothingOffered =
    offers !== null && !offers.email && !offers.phone && !offers.google;

  let body: ReactNode;
  if (step.kind === "methods") {
    body = (
      <>
        {readiness === "loading" ? (
          <p className="text-sm text-muted" role="status">
            {t("nativecloudsignin.Checking", {
              defaultValue: "Checking sign-in options…",
            })}
          </p>
        ) : null}
        {showGoogle ? (
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={startGoogle}
            data-testid="native-cloud-sign-in-google"
          >
            {t("nativecloudsignin.Google", {
              defaultValue: "Continue with Google",
            })}
          </Button>
        ) : null}
        {showEmail ? (
          <form className="flex flex-col gap-2" onSubmit={startEmail}>
            <Label htmlFor="native-cloud-sign-in-email">
              {t("nativecloudsignin.Email", { defaultValue: "Email" })}
            </Label>
            <Input
              id="native-cloud-sign-in-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="native-cloud-sign-in-email"
            />
            <Button
              type="submit"
              size="lg"
              disabled={busy || !email.trim()}
              data-testid="native-cloud-sign-in-email-send"
            >
              {t("nativecloudsignin.EmailSend", {
                defaultValue: "Email me a code",
              })}
            </Button>
          </form>
        ) : null}
        {showPhone ? (
          <form className="flex flex-col gap-2" onSubmit={startPhone}>
            <Label htmlFor="native-cloud-sign-in-phone">
              {t("nativecloudsignin.Phone", {
                defaultValue: "Phone number, with country code",
              })}
            </Label>
            <Input
              id="native-cloud-sign-in-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+14155550100"
              value={phone}
              disabled={busy}
              onChange={(event) => setPhone(event.target.value)}
              data-testid="native-cloud-sign-in-phone"
            />
            <Button
              type="submit"
              variant="outline"
              size="lg"
              disabled={busy || !phone.trim()}
              data-testid="native-cloud-sign-in-phone-send"
            >
              {t("nativecloudsignin.PhoneSend", {
                defaultValue: "Text me a code",
              })}
            </Button>
          </form>
        ) : null}
        {offers === null || nothingOffered ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void loadReadiness(true)}
            data-testid="native-cloud-sign-in-retry"
          >
            {t("nativecloudsignin.CheckAgain", {
              defaultValue: "Check sign-in options again",
            })}
          </Button>
        ) : null}
        {nothingOffered ? (
          <p className="text-sm text-muted" role="status">
            {androidNativeCloudSignInMessage(
              new NativeCloudSignInError("unavailable"),
            )}
          </p>
        ) : null}
      </>
    );
  } else if (step.kind === "mfa" && step.method === "passkey") {
    body = (
      <>
        <p className="text-sm text-txt" role="status">
          {androidNativeCloudSignInMessage(
            new NativeCloudSignInError("mfa-unsupported"),
          )}
        </p>
        <Button variant="outline" onClick={chooseAnotherMethod}>
          {t("nativecloudsignin.OtherMethod", {
            defaultValue: "Use another way to sign in",
          })}
        </Button>
      </>
    );
  } else {
    const waitSeconds =
      step.kind === "code" ? Math.ceil((step.resendAt - now) / 1000) : 0;
    body = (
      <form className="flex flex-col gap-3" onSubmit={verify}>
        <p className="text-sm text-muted">
          {step.kind === "code"
            ? t("nativecloudsignin.CodeSent", {
                defaultValue: "Enter the 6-digit code sent to {{destination}}.",
                destination: step.destination,
              })
            : step.method === "sms"
              ? t("nativecloudsignin.MfaSms", {
                  defaultValue:
                    "Enter the 6-digit code texted to your phone to finish signing in.",
                })
              : t("nativecloudsignin.MfaTotp", {
                  defaultValue:
                    "Enter the 6-digit code from your authenticator app to finish signing in.",
                })}
        </p>
        <Input
          aria-label={t("nativecloudsignin.Code", { defaultValue: "Code" })}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={9}
          value={code}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
          data-testid="native-cloud-sign-in-code"
        />
        <Button
          type="submit"
          size="lg"
          disabled={busy || !code.trim()}
          data-testid="native-cloud-sign-in-verify"
        >
          {t("nativecloudsignin.Verify", { defaultValue: "Sign in" })}
        </Button>
        {step.kind === "code" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || waitSeconds > 0}
            onClick={resend}
            data-testid="native-cloud-sign-in-resend"
          >
            {waitSeconds > 0
              ? t("nativecloudsignin.ResendIn", {
                  defaultValue: "Send a new code in {{seconds}}s",
                  seconds: waitSeconds,
                })
              : t("nativecloudsignin.Resend", {
                  defaultValue: "Send a new code",
                })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={chooseAnotherMethod}
        >
          {t("nativecloudsignin.OtherMethod", {
            defaultValue: "Use another way to sign in",
          })}
        </Button>
      </form>
    );
  }

  return (
    <Card
      asChild
      variant="sandboxFrame"
      className="fixed inset-0 z-[1000] flex min-h-screen w-full items-center justify-center overflow-y-auto px-4 py-6 font-body text-txt sm:px-6"
    >
      <main data-testid="native-cloud-sign-in">
        <Card
          surface="cardOverlay"
          border="subtle"
          className="relative z-10 w-full max-w-[560px] overflow-hidden"
        >
          <CardHeader className="pb-5 pt-6">
            <div className="flex flex-col gap-4">
              <Badge
                asChild
                variant="default"
                size="providerMark"
                aria-label={t("cloudsigninrecovery.CloudSignIn", {
                  defaultValue: "Eliza Cloud sign in",
                })}
                className="size-9"
                role="img"
              >
                <span>
                  <Cloud className="size-5" aria-hidden />
                </span>
              </Badge>
              <h1 className="text-xl font-semibold leading-tight text-txt">
                {t("cloudsigninrecovery.Title", {
                  defaultValue: "Sign in to Eliza Cloud",
                })}
              </h1>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-5">
            {error ? (
              <p
                className="rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm leading-relaxed text-txt"
                role="alert"
                data-testid="native-cloud-sign-in-error"
              >
                {error}
              </p>
            ) : null}
            {body}
            <Button
              variant="ghost"
              size="sm"
              onClick={leave}
              data-testid="native-cloud-sign-in-cancel"
            >
              {t("nativecloudsignin.Cancel", { defaultValue: "Cancel" })}
            </Button>
          </CardContent>
        </Card>
      </main>
    </Card>
  );
}

/**
 * Renders the native sign-in screens while a sign-in is requested, and
 * `fallback` otherwise. Mounted by the app shell on Android Cloud builds.
 */
export function AndroidNativeCloudSignInHost({
  fallback = null,
  port,
}: {
  fallback?: ReactNode;
  port?: ElizaNativeCloudSignInPort;
}) {
  const request = useSyncExternalStore(
    subscribeAndroidNativeCloudSignInRequest,
    getAndroidNativeCloudSignInRequest,
    getAndroidNativeCloudSignInRequest,
  );
  if (!request) return <>{fallback}</>;
  return (
    <AndroidNativeCloudSignInView
      key={request.id}
      request={request}
      port={port}
    />
  );
}
