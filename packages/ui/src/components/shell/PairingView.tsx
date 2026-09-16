/**
 * Full-screen gate shown when the backend requires a device-pairing code before
 * the shell will connect. Reads pairing state (enabled, expiry, input, error,
 * busy) from the app store and submits the entered code via
 * `handlePairingSubmit`. Blocks the rest of the shell until pairing succeeds.
 */

import { useEffect, useState } from "react";
import { client } from "../../api";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { startFreshFirstRunReload } from "../../platform";
import { useAppSelectorShallow } from "../../state";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SemanticForm } from "../ui/semantic-form";
import { PairingCommandHint } from "./PairingCommandHint";

const SCREEN_SHELL_CLASS =
  "relative flex min-h-screen w-full items-center justify-center overflow-y-auto px-4 py-6 font-body text-txt sm:px-6";
export function PairingView() {
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const {
    pairingEnabled,
    pairingExpiresAt,
    pairingCodeInput,
    pairingError,
    pairingBusy,
    handlePairingSubmit,
    setState,
    t,
  } = useAppSelectorShallow((s) => ({
    pairingEnabled: s.pairingEnabled,
    pairingExpiresAt: s.pairingExpiresAt,
    pairingCodeInput: s.pairingCodeInput,
    pairingError: s.pairingError,
    pairingBusy: s.pairingBusy,
    handlePairingSubmit: s.handlePairingSubmit,
    setState: s.setState,
    t: s.t,
  }));
  const branding = useBranding();
  const pairingCode = pairingCodeInput.trim();

  // PairingView can be selected by the independent /api/auth/me gate after
  // startup has already advanced to a paintable shell. In that path the
  // startup poll never populated the pairing slice, so its initial `false`
  // must not be mistaken for an authoritative "pairing disabled" response.
  // Hydrate from the public, secret-free auth-status contract whenever this
  // surface mounts; this is also the source of truth for code expiry.
  useEffect(() => {
    let active = true;
    void client
      .getAuthStatus()
      .then((status) => {
        if (!active) return;
        setStatusUnavailable(false);
        setState("pairingEnabled", status.pairingEnabled === true);
        setState("pairingExpiresAt", status.expiresAt);
      })
      .catch(() => {
        // error-policy:J4 an auth-status diagnostic failure remains fail-closed
        // and is shown as an explicit unavailable state.
        if (active) setStatusUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [setState]);

  function formatExpiry(timestamp: number | null): string {
    if (!timestamp) return "";
    const now = Date.now();
    const diff = timestamp - now;
    if (diff <= 0) return t("pairingview.Expired");
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return t("pairingview.ExpiresIn", {
      time: `${minutes}:${seconds.toString().padStart(2, "0")}`,
    });
  }

  const expiryText = formatExpiry(pairingExpiresAt);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setState("pairingCodeInput", e.target.value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void handlePairingSubmit();
  };

  return (
    <Card asChild variant="sandboxFrame" className={SCREEN_SHELL_CLASS}>
      <div>
        <Card
          asChild
          border="none"
          radius="none"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          visualStyle={{
            background:
              "radial-gradient(circle at top, rgb(var(--accent-rgb) / 12%), transparent 30%), linear-gradient(180deg, rgb(255 255 255 / 2%), transparent 40%)",
          }}
        >
          <div />
        </Card>
        <Card variant="pairingGate">
          {statusUnavailable ? (
            <Alert
              variant="destructive"
              role="alert"
              className="px-6 py-3 text-sm"
            >
              {t("pairingview.StatusUnavailable", {
                defaultValue:
                  "Pairing status is unavailable. Check the connection and reopen this screen.",
              })}
            </Alert>
          ) : null}
          <CardHeader className="pb-6 pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1.5">
                <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
                  {branding.appName}
                </div>
                <CardTitle className="text-xl text-txt-strong">
                  {t("pairingview.PairingRequired")}
                </CardTitle>
                <CardDescription className="max-w-[48ch] text-sm leading-relaxed">
                  {t("pairingview.EnterThePairingCo")}
                </CardDescription>
              </div>
              {pairingEnabled && expiryText ? (
                <div
                  id="pairing-code-expiry"
                  aria-live="polite"
                  className="inline-flex min-h-10 items-center text-xs font-medium text-muted"
                >
                  {expiryText}
                </div>
              ) : null}
            </div>
          </CardHeader>

          <CardContent className="pt-6">
            {pairingEnabled ? (
              <SemanticForm
                onSubmit={handleSubmit}
                aria-busy={pairingBusy}
                className="space-y-6"
              >
                {/* Flat — no inner box. Whitespace separates the field group. */}
                <div>
                  <div className="mb-3">
                    <Label
                      htmlFor="pairing-code"
                      className="text-sm font-semibold"
                    >
                      {t("pairingview.PairingCode")}
                    </Label>
                  </div>
                  <div className="mb-4">
                    <PairingCommandHint remoteUrl={client.getBaseUrl()} />
                  </div>
                  <Input
                    id="pairing-code"
                    type="text"
                    value={pairingCodeInput}
                    onChange={handleCodeChange}
                    placeholder={t("pairingview.EnterPairingCode")}
                    disabled={pairingBusy}
                    autoFocus
                    autoCapitalize="characters"
                    autoCorrect="off"
                    enterKeyHint="done"
                    spellCheck={false}
                    aria-invalid={pairingError ? "true" : "false"}
                    aria-describedby={
                      [
                        pairingError ? "pairing-code-error" : null,
                        expiryText ? "pairing-code-expiry" : null,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    variant="form"
                    density="search"
                  />
                </div>

                {pairingError ? (
                  <Card
                    asChild
                    variant="dangerNotice"
                    id="pairing-code-error"
                    role="alert"
                    className="p-3 text-sm leading-relaxed"
                  >
                    <div>{pairingError}</div>
                  </Card>
                ) : null}

                <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    asChild
                    variant="outline"
                    size="lg"
                    className="w-full sm:w-auto sm:min-w-[12rem]"
                  >
                    <a
                      href={`https://github.com/${branding.orgName}/${branding.repoName}/blob/develop/docs/api-reference.mdx`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("pairingview.PairingSetupDocs")}
                    </a>
                  </Button>
                  <Button
                    type="submit"
                    variant="default"
                    size="lg"
                    className="w-full sm:w-auto sm:min-w-[9rem]"
                    disabled={pairingBusy || !pairingCode}
                  >
                    {pairingBusy
                      ? t("pairingview.PairingInProgress")
                      : t("common.submit")}
                  </Button>
                </div>
              </SemanticForm>
            ) : (
              <div className="space-y-5 text-sm">
                <p className="leading-relaxed text-muted">
                  {t("pairingview.PairingIsNotEnabl")}
                </p>

                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                    {t("pairingview.NextSteps")}
                  </p>
                  <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-txt">
                    <li>{t("pairingview.AskTheServerOwner")}</li>
                    <li>
                      {t(
                        "pairingview.EnablePairingOnTh",
                        appNameInterpolationVars(branding),
                      )}
                    </li>
                  </ol>
                </div>

                {/* In-app escape: pairing is disabled with no token field, so
                  this screen is otherwise a dead end. Let the user abandon the
                  stale server and start over on a local agent. */}
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    className="w-full sm:w-auto sm:min-w-[12rem]"
                    onClick={() => startFreshFirstRunReload()}
                  >
                    {t("pairingview.UseLocalInstead", {
                      defaultValue: "Use a local agent instead",
                    })}
                  </Button>
                  <Button
                    asChild
                    variant="outline"
                    size="lg"
                    className="w-full sm:w-auto sm:min-w-[12rem]"
                  >
                    <a
                      href={`https://github.com/${branding.orgName}/${branding.repoName}/blob/develop/docs/api-reference.mdx`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("pairingview.PairingSetupDocs")}
                    </a>
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Card>
  );
}
