/** One sign-in surface for native mobile hosts. The controller owns attempts; forms own codes. */
import {
  type NativeCloudSignInCopy,
  NativeCloudSignInError,
  nativeCloudSignInFailureMessage,
} from "@elizaos/auth/auth/native-cloud-sign-in";
import { Cloud } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type CloudServiceInfo,
  parseCloudServiceInfo,
} from "./native-cloud-service-info";
import type { NativeCloudSignInController } from "./native-cloud-sign-in-controller";

type Translate = (
  key: string,
  options: { defaultValue: string; [key: string]: unknown },
) => string;
export interface NativeCloudSignInViewProps<E extends string> {
  controller: NativeCloudSignInController<E>;
  copy: NativeCloudSignInCopy;
  translate?: Translate;
  title?: string;
  headingId?: string;
  embedded?: boolean;
  dismissible?: boolean;
  extra?: ReactNode;
  activationMessage?: (error: unknown) => string;
  serviceLoader?: (environment: E) => Promise<unknown>;
  brand?: ReactNode;
}
export function NativeCloudSignInView<E extends string>({
  controller,
  copy,
  translate,
  title,
  headingId = "native-cloud-sign-in-title",
  embedded = false,
  dismissible = true,
  extra,
  serviceLoader,
  brand,
  activationMessage,
}: NativeCloudSignInViewProps<E>) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { step, readiness, busy, stage, activationError, operation } = snapshot;
  const [email, setEmail] = useState(""),
    [phone, setPhone] = useState(""),
    [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const googleButton = useRef<HTMLButtonElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const initialFocusSet = useRef(false);
  const [service, setService] = useState<CloudServiceInfo | null>(null);
  const [serviceError, setServiceError] = useState(false);
  const [serviceRevision, setServiceRevision] = useState(0);
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);
  const legalHeading = useRef<HTMLHeadingElement>(null),
    legalTrigger = useRef<HTMLButtonElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry button intentionally requests the same public document again.
  useEffect(() => {
    let current = true;
    setService(null);
    setServiceError(false);
    setLegal(null);
    if (serviceLoader)
      void serviceLoader(snapshot.environment)
        .then((value) => {
          if (current) setService(parseCloudServiceInfo(value));
        })
        .catch(() => {
          if (current) setServiceError(true);
        });
    return () => {
      current = false;
    };
  }, [serviceLoader, snapshot.environment, serviceRevision]);
  useEffect(() => {
    if (legal) legalHeading.current?.focus();
    else legalTrigger.current?.focus();
  }, [legal]);
  const t: Translate =
    translate ??
    ((_key, options) =>
      options.defaultValue.replace(/{{(\w+)}}/g, (_match, key) =>
        String(options[key] ?? ""),
      ));
  const message = (error: unknown) =>
    nativeCloudSignInFailureMessage(
      NativeCloudSignInError.from(error).code,
      copy,
    );
  const error = snapshot.error ? message(snapshot.error) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new attempt/step clears the previous form code, while retries keep it.
  useEffect(() => {
    setCode("");
  }, [step]);
  useEffect(() => {
    setNow(Date.now());
    if (step.kind !== "code" || step.resendAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);
  const startEmail = (event: FormEvent) => {
    event.preventDefault();
    void controller.startEmail(email);
  };
  const startPhone = (event: FormEvent) => {
    event.preventDefault();
    void controller.startPhone(phone);
  };
  const startGoogle = () => void controller.startGoogle();
  const verify = (event: FormEvent) => {
    event.preventDefault();
    void controller.verify(code);
  };
  const resend = () => void controller.resend();
  const chooseAnotherMethod = () => void controller.chooseAnotherMethod();
  const loadReadiness = (refresh: boolean) =>
    controller.refreshReadiness(refresh);
  const cancel = () => {
    if (readiness === "loading" && !busy && !dismissible)
      controller.retireReadiness();
    else if (stage === "activating") controller.leave();
    else if (step.kind !== "methods" || busy)
      void controller.chooseAnotherMethod();
    else controller.leave();
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
  useEffect(() => {
    if (busy || stage !== "choosing") return;
    if (!embedded && !initialFocusSet.current && readiness !== "loading") {
      initialFocusSet.current = true;
      heading.current?.focus();
    } else if (step.kind !== "methods") codeInput.current?.focus();
    else
      (showGoogle
        ? googleButton
        : showEmail
          ? emailInput
          : phoneInput
      ).current?.focus();
  }, [busy, stage, step.kind, showGoogle, showEmail, embedded, readiness]);

  let body: ReactNode;
  const Body = embedded ? "div" : "main";
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
          <button
            type="button"
            ref={googleButton}
            className="w-full"
            disabled={busy}
            onClick={startGoogle}
            data-testid="native-cloud-sign-in-google"
          >
            {t("nativecloudsignin.Google", {
              defaultValue: "Continue with Google",
            })}
          </button>
        ) : null}
        {showEmail ? (
          <form
            aria-label={t("nativecloudsignin.EmailForm", {
              defaultValue: "Sign in with email",
            })}
            className="flex flex-col gap-2"
            onSubmit={startEmail}
          >
            <label htmlFor="native-cloud-sign-in-email">
              {t("nativecloudsignin.Email", { defaultValue: "Email" })}
            </label>
            <input
              id="native-cloud-sign-in-email"
              ref={emailInput}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="native-cloud-sign-in-email"
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              data-testid="native-cloud-sign-in-email-send"
            >
              {t("nativecloudsignin.EmailSend", {
                defaultValue: "Email me a code",
              })}
            </button>
          </form>
        ) : null}
        {showPhone ? (
          <form
            aria-label={t("nativecloudsignin.PhoneForm", {
              defaultValue: "Sign in with phone",
            })}
            className="flex flex-col gap-2"
            onSubmit={startPhone}
          >
            <label htmlFor="native-cloud-sign-in-phone">
              {t("nativecloudsignin.Phone", {
                defaultValue: "Phone number with country code",
              })}
            </label>
            <input
              id="native-cloud-sign-in-phone"
              ref={phoneInput}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+14155550100"
              value={phone}
              disabled={busy}
              onChange={(event) => setPhone(event.target.value)}
              data-testid="native-cloud-sign-in-phone"
            />
            <button
              type="submit"
              disabled={busy || !phone.trim()}
              data-testid="native-cloud-sign-in-phone-send"
            >
              {t("nativecloudsignin.PhoneSend", {
                defaultValue: "Text me a code",
              })}
            </button>
          </form>
        ) : null}
        {offers === null || nothingOffered ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void loadReadiness(true)}
            data-testid="native-cloud-sign-in-retry"
          >
            {t("nativecloudsignin.CheckAgain", {
              defaultValue: "Check sign-in options again",
            })}
          </button>
        ) : null}
        {nothingOffered ? (
          <p className="text-sm text-muted" role="status">
            {message(new NativeCloudSignInError("unavailable"))}
          </p>
        ) : null}
      </>
    );
  } else if (step.kind === "mfa" && step.method === "passkey") {
    body = (
      <>
        <p className="text-sm text-txt" role="status">
          {message(new NativeCloudSignInError("mfa-unsupported"))}
        </p>
        <button type="button" onClick={chooseAnotherMethod}>
          {t("nativecloudsignin.OtherMethod", {
            defaultValue: "Use another way to sign in",
          })}
        </button>
      </>
    );
  } else {
    const waitSeconds =
      step.kind === "code" ? Math.ceil((step.resendAt - now) / 1000) : 0;
    body = (
      <form
        aria-label={
          step.kind === "mfa"
            ? t("nativecloudsignin.VerificationForm", {
                defaultValue: "Enter your verification code",
              })
            : step.channel === "email"
              ? t("nativecloudsignin.EmailCodeForm", {
                  defaultValue: "Enter your email code",
                })
              : t("nativecloudsignin.PhoneCodeForm", {
                  defaultValue: "Enter your phone code",
                })
        }
        className="flex flex-col gap-3"
        onSubmit={verify}
      >
        <p className="text-sm text-muted">
          {step.kind === "code"
            ? t("nativecloudsignin.CodeSent", {
                defaultValue: "Enter the 6-digit code sent to {{destination}}.",
                destination: step.destination,
              })
            : step.method === "sms"
              ? t("nativecloudsignin.MfaSms", {
                  defaultValue: "Enter the six-digit code sent to your phone.",
                })
              : t("nativecloudsignin.MfaTotp", {
                  defaultValue:
                    "This account uses an authenticator app. Enter its six-digit code.",
                })}
        </p>
        <input
          aria-label={t("nativecloudsignin.Code", {
            defaultValue: "Six-digit code",
          })}
          ref={codeInput}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={9}
          value={code}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
          data-testid="native-cloud-sign-in-code"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          data-testid="native-cloud-sign-in-verify"
        >
          {busy
            ? t("nativecloudsignin.CheckingCode", {
                defaultValue: "Checking code…",
              })
            : t("nativecloudsignin.Verify", { defaultValue: "Verify" })}
        </button>
        {step.kind === "code" ? (
          <button
            type="button"
            disabled={busy || waitSeconds > 0}
            onClick={resend}
            data-testid="native-cloud-sign-in-resend"
          >
            {waitSeconds > 0
              ? t("nativecloudsignin.ResendIn", {
                  defaultValue: "Resend code in {{seconds}}s",
                  seconds: waitSeconds,
                })
              : t("nativecloudsignin.Resend", {
                  defaultValue: "Resend code",
                })}
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={chooseAnotherMethod}>
          {t("nativecloudsignin.OtherMethod", {
            defaultValue: "Use another way to sign in",
          })}
        </button>
      </form>
    );
  }

  return (
    <div
      data-native-cloud-sign-in
      data-native-sign-in-overlay={embedded ? undefined : "true"}
      className={
        embedded
          ? "w-full min-w-0 font-body text-txt"
          : "fixed inset-0 z-[1000] flex min-h-screen w-full items-center justify-center overflow-y-auto px-4 py-6 font-body text-txt sm:px-6"
      }
    >
      <Body data-testid="native-cloud-sign-in" data-native-sign-in-body>
        <div
          data-native-sign-in-panel
          className="relative z-10 w-full max-w-[560px] overflow-hidden"
        >
          <header className="pb-5 pt-6">
            <div className="flex flex-col gap-4">
              {brand ?? (
                <span
                  aria-label={t("cloudsigninrecovery.CloudSignIn", {
                    defaultValue: `${copy.serviceName} sign in`,
                  })}
                  className="size-9"
                  role="img"
                >
                  <span>
                    <Cloud className="size-5" aria-hidden />
                  </span>
                </span>
              )}
              <h1
                id={headingId}
                ref={heading}
                tabIndex={-1}
                className="text-xl font-semibold leading-tight text-txt"
              >
                {title ??
                  t("cloudsigninrecovery.Title", {
                    defaultValue: "Sign in to {{serviceName}}",
                    serviceName: copy.serviceName,
                  })}
              </h1>
            </div>
          </header>
          <div className="flex flex-col gap-4 pt-5">
            <div hidden={legal !== null}>
              <p>
                {t("nativecloudsignin.AccountPrompt", {
                  defaultValue: "Use your {{serviceName}} account to sign in.",
                  serviceName: service?.name ?? copy.serviceName,
                })}
              </p>
              <p role="note">
                {t("nativecloudsignin.AccessNotice", {
                  defaultValue:
                    "Sign in to verify your account. You’ll review access before authorizing {{productName}}.",
                  productName: copy.productName,
                })}
              </p>
              {error ? (
                <p
                  className="rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm leading-relaxed text-txt"
                  role="alert"
                  data-testid="native-cloud-sign-in-error"
                >
                  {error}
                </p>
              ) : null}
              {stage === "activating" ? (
                <div role={activationError ? "alert" : "status"}>
                  <p>
                    {activationError
                      ? (activationMessage?.(activationError) ??
                        t("nativecloudsignin.ActivationFailed", {
                          defaultValue:
                            "Account verification did not complete. Try again.",
                        }))
                      : t("nativecloudsignin.VerifyingAccount", {
                          defaultValue:
                            "Verifying your account and connecting your agent…",
                        })}
                  </p>
                  {activationError ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void controller.retryActivation()}
                    >
                      {t("nativecloudsignin.RetryConnection", {
                        defaultValue: "Retry connection",
                      })}
                    </button>
                  ) : null}
                </div>
              ) : stage === "complete" ? (
                <p role="status">
                  {t("nativecloudsignin.SignedIn", {
                    defaultValue: "Signed in.",
                  })}
                </p>
              ) : busy && operation === "google" ? (
                <p role="status">
                  {t("nativecloudsignin.GooglePrompt", {
                    defaultValue:
                      "Choose your Google account in the Android sign-in sheet. {{productName}} will finish signing you in.",
                    productName: copy.productName,
                  })}
                </p>
              ) : (
                body
              )}
              {extra}
              {(dismissible ||
                step.kind !== "methods" ||
                busy ||
                readiness === "loading") && (
                <button
                  type="button"
                  onClick={cancel}
                  data-testid="native-cloud-sign-in-cancel"
                  data-native-sign-in-secondary
                >
                  {t("nativecloudsignin.Cancel", {
                    defaultValue:
                      step.kind === "methods" &&
                      !busy &&
                      readiness !== "loading"
                        ? "Back"
                        : "Cancel sign-in",
                  })}
                </button>
              )}
              {service && (
                <p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(event) => {
                      legalTrigger.current = event.currentTarget;
                      setLegal("terms");
                    }}
                  >
                    {t("nativecloudsignin.TermsOfService", {
                      defaultValue: "Terms of Service",
                    })}
                  </button>{" "}
                  {t("nativecloudsignin.LegalAnd", { defaultValue: "and" })}{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(event) => {
                      legalTrigger.current = event.currentTarget;
                      setLegal("privacy");
                    }}
                  >
                    {t("nativecloudsignin.PrivacyPolicy", {
                      defaultValue: "Privacy Policy",
                    })}
                  </button>
                  .
                </p>
              )}
              {serviceError && (
                <p role="status">
                  {t("nativecloudsignin.ServiceUnavailable", {
                    defaultValue: "Service information is unavailable.",
                  })}{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setServiceRevision((value) => value + 1)}
                  >
                    {t("nativecloudsignin.RetryServiceInfo", {
                      defaultValue: "Retry service information",
                    })}
                  </button>
                </p>
              )}
            </div>
            {legal && service && (
              <section aria-labelledby="native-cloud-legal-title">
                <button type="button" onClick={() => setLegal(null)}>
                  {t("nativecloudsignin.BackToSignIn", {
                    defaultValue: "Back to sign-in",
                  })}
                </button>
                <h2
                  id="native-cloud-legal-title"
                  tabIndex={-1}
                  ref={legalHeading}
                >
                  {service[legal].title}
                </h2>
                <p>
                  {t("nativecloudsignin.ServiceRevision", {
                    defaultValue: "{{serviceName}} · Revision {{revision}}",
                    serviceName: service.name,
                    revision: service[legal].revision,
                  })}
                </p>
                {service[legal].sections.map((section, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: public document sections have fixed order and no local state.
                  <section key={index}>
                    <h3>{section.title}</h3>
                    {section.paragraphs.map((paragraph, i) => (
                      <p
                        // biome-ignore lint/suspicious/noArrayIndexKey: public paragraphs have fixed order and no local state.
                        key={i}
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {paragraph}
                      </p>
                    ))}
                  </section>
                ))}
                <button type="button" onClick={() => setLegal(null)}>
                  {t("nativecloudsignin.ReturnToSignIn", {
                    defaultValue: "Return to sign-in",
                  })}
                </button>
              </section>
            )}
          </div>
        </div>
      </Body>
    </div>
  );
}
