/**
 * BootstrapStep — cloud-provisioned containers only.
 *
 * If the dashboard linked here with `#bootstrap=<token>`, the token is read
 * once on mount, scrubbed from the URL, and exchanged automatically — no
 * paste required. Otherwise the manual paste form is shown as a fallback.
 *
 * On success the returned session id is written to
 * sessionStorage["eliza_session"] and the `onAdvance` callback fires.
 *
 * P1 will migrate the session to an HttpOnly cookie and retire sessionStorage.
 * The key name is kept in sync with the cookie name planned for P1
 * (eliza_session) so the P1 migration is a straightforward swap.
 *
 * Error contract (fail closed):
 *   401 → token invalid / expired / already used, single-use, must rotate.
 *   429 → rate limited.
 *   5xx → server not ready.
 *   network → surfaces to user; never treated as success.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { client } from "../../api";
import type { BootstrapExchangeResult } from "../../api/client-agent";
import { cn } from "../../lib/utils";
import { startFreshFirstRunReload } from "../../platform";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext";
import {
  SetupField,
  setupDetailStackClassName,
  setupHelperTextClassName,
  setupInputClassName,
  setupReadableTextFaintClassName,
  setupReadableTextMutedClassName,
} from "./setup-form-primitives";
import {
  SetupStepDivider,
  setupBodyTextShadowStyle,
  setupDescriptionClass,
  setupEyebrowClass,
  setupFooterClass,
  setupHeaderBlockClass,
  setupPrimaryActionClass,
  setupPrimaryActionTextShadowStyle,
  setupTextShadowStyle,
  setupTitleClass,
} from "./setup-step-chrome";

const SESSION_STORAGE_KEY = "eliza_session";
const MONO_FONT = "'Poppins', Arial, system-ui, sans-serif";
const BOOTSTRAP_HASH_PARAM = "bootstrap";

/**
 * If the dashboard handed off the token via `#bootstrap=<token>`, read it once
 * on mount so the container can auto-activate without a manual paste.
 * Fragment (not query) so the token never reaches the server or referer logs.
 */
function readBootstrapTokenFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const value = params.get(BOOTSTRAP_HASH_PARAM);
  return value && value.length > 0 ? value : null;
}

function scrubBootstrapTokenFromHash(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (hash.length < 2) return;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has(BOOTSTRAP_HASH_PARAM)) return;
  params.delete(BOOTSTRAP_HASH_PARAM);
  const remaining = params.toString();
  const newHash = remaining.length > 0 ? `#${remaining}` : "";
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${newHash}`,
  );
}

export interface BootstrapStepProps {
  /**
   * Called after a successful exchange. The caller is responsible for
   * advancing startup.
   */
  onAdvance: () => void;
  /**
   * Injected exchange function — defaults to the real API client call but
   * can be swapped in tests.
   */
  exchangeFn?: (token: string) => Promise<BootstrapExchangeResult>;
}

type SubmitState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; message: string; tone: "danger" }
  | { phase: "success" };

function describeError(
  result: BootstrapExchangeResult & { ok: false },
  t: TranslationContextValue["t"],
): string {
  if (result.status === 429) {
    return t("bootstrapstep.errorRateLimited", {
      defaultValue: "Too many attempts — wait a minute and try again.",
    });
  }
  if (result.status === 503) {
    return t("bootstrapstep.errorServerNotReady", {
      defaultValue: "The server is not ready. Reload the page and try again.",
    });
  }
  if (result.status === 400) {
    return t("bootstrapstep.errorNoToken", {
      defaultValue:
        "No token provided. Paste the token from your Eliza Cloud dashboard.",
    });
  }
  // 401 — invalid / expired / already used
  return t("bootstrapstep.errorInvalidToken", {
    defaultValue:
      "Token invalid, expired, or already used. Bootstrap tokens are single-use — rotate from your Eliza Cloud dashboard to get a new one.",
  });
}

export function BootstrapStep({ onAdvance, exchangeFn }: BootstrapStepProps) {
  const { t } = useTranslation();
  const fieldId = useId().replace(/:/g, "");
  const [token, setToken] = useState("");
  // Lazy-init to "submitting" when an auto-activate token is present so the
  // first paint shows "Verifying…" instead of an empty paste form.
  const [submitState, setSubmitState] = useState<SubmitState>(() =>
    readBootstrapTokenFromHash() !== null
      ? { phase: "submitting" }
      : { phase: "idle" },
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const didAutoExchangeRef = useRef(false);

  const doExchange = useCallback(
    async (rawToken: string): Promise<void> => {
      setSubmitState({ phase: "submitting" });

      let result: BootstrapExchangeResult;
      try {
        if (exchangeFn) {
          result = await exchangeFn(rawToken);
        } else {
          // `client` is statically imported above. The `exchangeFn` injection
          // path remains the test seam; this branch is the production path.
          result = await client.postBootstrapExchange(rawToken);
        }
      } catch (err) {
        // Network down or unexpected throw — surface to user, do not proceed.
        const message =
          err instanceof Error && err.message
            ? err.message
            : t("bootstrapstep.errorNetwork", {
                defaultValue:
                  "Network error — check your connection and try again.",
              });
        setSubmitState({ phase: "error", message, tone: "danger" });
        return;
      }

      if (result.ok === false) {
        setSubmitState({
          phase: "error",
          message: describeError(result, t),
          tone: "danger",
        });
        return;
      }

      // P0 bridge: write session id to sessionStorage. P1 replaces this with
      // an HttpOnly cookie set by the server on the exchange response.
      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, result.sessionId);
      } catch {
        // sessionStorage unavailable (e.g. private browsing on some browsers).
        // Session is still in memory for this page load; startup can advance.
      }
      client.setToken(result.sessionId);

      setSubmitState({ phase: "success" });
      onAdvance();
    },
    [exchangeFn, onAdvance, t],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = token.trim();
      if (!trimmed) return;
      void doExchange(trimmed);
    },
    [token, doExchange],
  );

  useEffect(() => {
    if (didAutoExchangeRef.current) return;
    const hashToken = readBootstrapTokenFromHash();
    if (!hashToken) return;
    didAutoExchangeRef.current = true;
    // Scrub before exchange so the token never lingers in window.history,
    // even if exchange throws or the user navigates away mid-flight.
    scrubBootstrapTokenFromHash();
    void doExchange(hashToken);
  }, [doExchange]);

  const isSubmitting = submitState.phase === "submitting";

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={t("bootstrapstep.formLabel", {
        defaultValue: "Bootstrap token entry",
      })}
      className="flex w-full flex-col gap-6"
    >
      {/* Header */}
      <div className={setupHeaderBlockClass}>
        <p className={setupEyebrowClass} style={setupBodyTextShadowStyle}>
          Eliza Cloud
        </p>
        <SetupStepDivider />
        <h1 className={setupTitleClass} style={setupTextShadowStyle}>
          {t("bootstrapstep.title", {
            defaultValue: "Finish setting up your container",
          })}
        </h1>
        <p className={setupDescriptionClass} style={setupBodyTextShadowStyle}>
          {t("bootstrapstep.description", {
            defaultValue:
              "Paste the bootstrap token from your Eliza Cloud dashboard to activate this container.",
          })}
        </p>
      </div>

      {/* Field */}
      <div className={setupDetailStackClassName}>
        <SetupField
          controlId={fieldId}
          label={t("bootstrapstep.tokenLabel", {
            defaultValue: "Bootstrap token",
          })}
          message={
            submitState.phase === "error" ? submitState.message : undefined
          }
          messageTone={
            submitState.phase === "error" ? submitState.tone : undefined
          }
        >
          {({ describedBy, invalid }) => (
            <input
              ref={inputRef}
              id={fieldId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("bootstrapstep.tokenPlaceholder", {
                defaultValue: "Paste your bootstrap token here",
              })}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                if (submitState.phase === "error") {
                  setSubmitState({ phase: "idle" });
                }
              }}
              disabled={isSubmitting}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              className={cn(
                setupInputClassName,
                invalid &&
                  "border-[var(--danger)] focus-visible:border-[var(--danger)]",
              )}
            />
          )}
        </SetupField>
      </div>

      {/* Where to get the token */}
      <div
        className={cn(
          "rounded-sm px-4 py-3",
          "border border-[rgba(240,185,11,0.18)] bg-[rgba(240,185,11,0.07)]",
        )}
      >
        <p
          className={cn(setupHelperTextClassName, "leading-relaxed")}
          style={setupBodyTextShadowStyle}
        >
          <span
            className={setupReadableTextMutedClassName}
            style={{ fontFamily: MONO_FONT }}
          >
            {t("bootstrapstep.whereToGet", {
              defaultValue: "Where do I get this?",
            })}
          </span>{" "}
          <span className={setupReadableTextFaintClassName}>
            {t("bootstrapstep.whereToGetDetail", {
              defaultValue:
                "Open your Eliza Cloud dashboard, select this container, and copy the token shown under “Bootstrap token”. It is valid for 24 hours and can only be used once.",
            })}{" "}
            <a
              href="/docs/security/bootstrap-token"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-[var(--first-run-text-muted)] transition-colors"
            >
              {t("bootstrapstep.learnMore", { defaultValue: "Learn more" })}
            </a>
          </span>
        </p>
      </div>

      {/* Footer */}
      <div className={cn(setupFooterClass, "justify-between")}>
        {/* Escape hatch: without a valid token this screen is otherwise a hard
            dead end (no back/cancel). Let the user abandon bootstrap and start
            over on a local agent instead of being trapped. */}
        <button
          type="button"
          onClick={() => startFreshFirstRunReload()}
          className="text-sm underline underline-offset-2 text-[var(--first-run-text-muted)] transition-opacity hover:opacity-80"
        >
          {t("bootstrapstep.startOver", { defaultValue: "Start over" })}
        </button>
        <button
          type="submit"
          disabled={isSubmitting || !token.trim()}
          className={setupPrimaryActionClass}
          style={setupPrimaryActionTextShadowStyle}
        >
          {isSubmitting
            ? t("bootstrapstep.verifying", { defaultValue: "Verifying…" })
            : t("bootstrapstep.activate", { defaultValue: "Activate" })}
        </button>
      </div>
    </form>
  );
}
