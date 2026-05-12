import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@elizaos/ui";
import { client } from "../../api";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { useApp } from "../../state";
import { PairingCommandHint } from "./PairingCommandHint";

const SCREEN_SHELL_CLASS =
  "relative flex min-h-screen w-full items-center justify-center overflow-y-auto bg-bg px-4 py-6 font-body text-txt sm:px-6";
const SCREEN_CARD_CLASS =
  "relative z-10 w-full max-w-[620px] overflow-hidden border border-border/60 bg-card/95 shadow-[0_30px_120px_rgba(0,0,0,0.35)] backdrop-blur-xl";
const SURFACE_PANEL_CLASS =
  "rounded-lg border border-border/50 bg-bg/40 p-4 shadow-sm sm:p-5";

export function PairingView() {
  const {
    pairingEnabled,
    pairingExpiresAt,
    pairingCodeInput,
    pairingError,
    pairingBusy,
    handlePairingSubmit,
    setState,
    t,
  } = useApp();
  const branding = useBranding();
  const pairingCode = pairingCodeInput.trim();

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
    <div className={SCREEN_SHELL_CLASS}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(var(--accent-rgb),0.12),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_40%)]"
      />
      <Card className={SCREEN_CARD_CLASS}>
        <CardHeader className="bg-card/70 pb-6 pt-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/80">
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
                className="inline-flex min-h-10 items-center rounded-xl border border-border/60 bg-bg/55 px-3 py-2 text-xs font-medium text-muted shadow-sm"
              >
                {expiryText}
              </div>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="pt-6">
          {pairingEnabled ? (
            <form
              onSubmit={handleSubmit}
              aria-busy={pairingBusy}
              className="space-y-6"
            >
              <div className={SURFACE_PANEL_CLASS}>
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
                  className="h-12 rounded-xl text-base sm:text-sm"
                />
              </div>

              {pairingError ? (
                <div
                  id="pairing-code-error"
                  role="alert"
                  className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-3 text-sm leading-relaxed text-danger"
                >
                  {pairingError}
                </div>
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
            </form>
          ) : (
            <div className="space-y-5 text-sm">
              <div className="rounded-xl border border-border/60 bg-bg/40 px-4 py-3.5 text-muted">
                <p className="leading-relaxed">
                  {t("pairingview.PairingIsNotEnabl")}
                </p>
              </div>

              <div className={`${SURFACE_PANEL_CLASS} space-y-3`}>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
