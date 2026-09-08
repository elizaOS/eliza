/** Keeps desktop session consumers unmounted after a settled protected-storage failure; retry reconciles storage before normal startup resumes, without repeating authentication or resetting data. */
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  initializeStorageBridge,
  isStorageRecoveryRequired,
  subscribeStorageRecovery,
} from "../../bridge/storage-bridge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";

interface StorageRecoveryViewProps {
  busy: boolean;
  retried: boolean;
  onRetry(): void;
  onReload(): void;
}

const RETRY_UNAVAILABLE =
  "The session is still unavailable. If another app window is finishing a sign-in, let it finish, then try again.";

// Startup runs before account display preferences. Scope the brand action
// tokens here so the recovery control remains orange in either host theme.
const recoveryTheme: CSSProperties & Record<`--${string}`, string> = {
  "--accent": "var(--brand-orange)",
  "--accent-foreground": "var(--brand-black)",
  "--accent-muted":
    "color-mix(in srgb, var(--brand-orange) 65%, var(--brand-black))",
  "--accent-subtle": "color-mix(in srgb, var(--brand-orange) 15%, transparent)",
  paddingTop: "max(2rem, env(safe-area-inset-top))",
  paddingBottom: "max(2rem, env(safe-area-inset-bottom))",
};

/** Context-free startup surface: it must render before the account and agent providers. */
export function StorageRecoveryView({
  busy,
  retried,
  onRetry,
  onReload,
}: StorageRecoveryViewProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main
      className="flex h-full min-h-0 w-full touch-pan-y flex-col items-center overflow-y-auto bg-bg px-4 py-8 font-body text-txt sm:px-6"
      style={recoveryTheme}
    >
      <Card
        className="my-auto w-full max-w-lg shrink-0"
        aria-labelledby="storage-recovery-title"
      >
        <CardHeader>
          <h1
            id="storage-recovery-title"
            ref={heading}
            tabIndex={-1}
            className="text-xl font-semibold text-txt-strong"
          >
            Your saved session is unavailable
          </h1>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-base leading-relaxed">
            We couldn’t verify the saved account and agent details. They have
            not been cleared. Your session can’t open until those details can be
            verified.
          </p>
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="grid text-sm leading-relaxed text-muted-strong"
          >
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1"
            >
              {RETRY_UNAVAILABLE}
            </span>
            <span className="col-start-1 row-start-1">
              {busy
                ? "Checking saved session…"
                : retried
                  ? RETRY_UNAVAILABLE
                  : "Retry checks saved data. If verified, the app resumes normal startup, which may start your saved local agent."}
            </span>
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              variant="accentDarkHover"
              size="lg"
              className="keyboard-focus-surface min-h-12 flex-1"
              onClick={onRetry}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? "Checking…" : "Retry"}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="keyboard-focus-surface min-h-12 flex-1"
              onClick={onReload}
              disabled={busy}
            >
              Reload app
            </Button>
          </div>
          <p className="text-sm leading-relaxed text-muted-strong">
            If retry and reload don’t help, keep your app data and contact
            support. Don’t clear storage to bypass this check.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

/** Uses the storage owner's settled-failure signal, not temporary in-flight write markers. */
export function StorageRecoveryBoundary({ children }: { children: ReactNode }) {
  const required = useSyncExternalStore(
    subscribeStorageRecovery,
    isStorageRecoveryRequired,
    () => false,
  );
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retried, setRetried] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const retry = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRetried(true);
    try {
      await initializeStorageBridge();
      setRetryFailed(isStorageRecoveryRequired());
    } catch {
      // error-policy:J4 retain the explicit recovery surface without exposing storage error details.
      setRetryFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (!required && !busy && !retryFailed) return children;
  return (
    <StorageRecoveryView
      busy={busy}
      retried={retried}
      onRetry={() => {
        void retry();
      }}
      onReload={() => window.location.reload()}
    />
  );
}
