/**
 * Contribute-credential modal for the org team pool (#11332).
 *
 * "Add your Anthropic / OpenAI / … API key" → paste (masked input) → POST
 * (the backend live-probes the key against the provider before pooling) →
 * masked confirmation (provider + ••••last4). The plaintext never comes back
 * from the API and is never rendered — the input masks it while typing and
 * that is the last time it exists client-side. Probe failures (400 "failed
 * live validation") render inline.
 *
 * Only the 6 Phase-1 direct providers are offered; subscription providers
 * (Claude Max / ChatGPT) are Phase 2 and never rendered.
 *
 * @param props.isOpen - Whether dialog is open
 * @param props.onClose - Callback when dialog closes
 * @param props.onSuccess - Callback after a credential is pooled
 */

import { AlertCircle, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  BrandButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../cloud-ui";
import { Button } from "../../components/ui/button";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  POOLED_PROVIDER_LABELS,
  POOLED_PROVIDERS,
  type PooledCredentialDto,
  type PooledProviderId,
} from "./data/cloud-org-types";
import { useContributeCredential } from "./data/use-credentials";
import { organizationErrorMessage } from "./data/use-organization";

interface ContributeCredentialDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function ContributeCredentialDialog({
  isOpen,
  onClose,
  onSuccess,
}: ContributeCredentialDialogProps) {
  const t = useCloudT();
  const [provider, setProvider] = useState<PooledProviderId>("anthropic-api");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PooledCredentialDto | null>(null);
  const contribute = useContributeCredential();
  const isSubmitting = contribute.isPending;

  const reset = () => {
    setProvider("anthropic-api");
    setApiKey("");
    setLabel("");
    setError(null);
    setResult(null);
  };

  const handleClose = () => {
    if (isSubmitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (apiKey.trim().length < 8) {
      setError(
        t("cloud.contributeCredential.keyTooShort", {
          defaultValue: "Paste a full API key",
        }),
      );
      return;
    }

    try {
      const data = await contribute.mutateAsync({
        provider,
        apiKey: apiKey.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setApiKey("");
      setResult(data);
      onSuccess();
    } catch (err) {
      setError(
        organizationErrorMessage(
          err,
          t("cloud.contributeCredential.failed", {
            defaultValue: "Failed to add credential",
          }),
        ),
      );
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="bg-neutral-950 border border-brand-surface p-4 sm:p-6 max-w-[95vw] sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white font-mono">
                <ShieldCheck className="h-5 w-5 text-green-500" />
                {t("cloud.contributeCredential.pooledTitle", {
                  defaultValue: "Key Added to the Pool",
                })}
              </DialogTitle>
              <DialogDescription className="text-white/60 font-mono text-xs md:text-sm">
                {t("cloud.contributeCredential.pooledDescription", {
                  provider: POOLED_PROVIDER_LABELS[provider],
                  defaultValue:
                    "Your {{provider}} key passed live validation and is encrypted in the org vault. It's never shown again in the dashboard — everyone sees just the last 4 characters.",
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3">
              <code className="text-xs font-mono text-white">
                {t("cloud.contributeCredential.maskedAs", {
                  last4: result.last4,
                  defaultValue: "Listed in the pool as ••••{{last4}}",
                })}
              </code>
            </div>

            <DialogFooter>
              <BrandButton
                type="button"
                variant="primary"
                onClick={handleClose}
                className="font-mono text-sm"
              >
                {t("cloud.contributeCredential.done", {
                  defaultValue: "Done",
                })}
              </BrandButton>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white font-mono">
                <KeyRound className="h-5 w-5 text-[var(--accent)]" />
                {t("cloud.contributeCredential.title", {
                  defaultValue: "Contribute an API Key",
                })}
              </DialogTitle>
              <DialogDescription className="text-white/60 font-mono text-xs md:text-sm">
                {t("cloud.contributeCredential.description", {
                  defaultValue:
                    "Add a provider API key to your organization's shared pool. The key is validated live against the provider, then encrypted — nobody can ever read it back.",
                })}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div
                  role="alert"
                  className="bg-[#EB4335]/10 border border-[#EB4335]/40 p-3 flex items-start gap-2"
                >
                  <AlertCircle className="h-4 w-4 text-[#EB4335] flex-shrink-0 mt-0.5" />
                  <p className="text-xs md:text-sm font-mono text-[#EB4335]">
                    {error}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label
                  htmlFor="credential-provider"
                  className="text-white font-mono text-sm"
                >
                  {t("cloud.contributeCredential.provider", {
                    defaultValue: "Provider",
                  })}
                </Label>
                <Select
                  value={provider}
                  onValueChange={(value) =>
                    setProvider(value as PooledProviderId)
                  }
                  disabled={isSubmitting}
                >
                  <SelectTrigger
                    id="credential-provider"
                    className="bg-transparent border-[#303030] text-white"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a1a] border-[#303030]">
                    {POOLED_PROVIDERS.map((id) => (
                      <SelectItem key={id} value={id}>
                        <span className="font-mono text-white">
                          {POOLED_PROVIDER_LABELS[id]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="credential-api-key"
                  className="text-white font-mono text-sm"
                >
                  {t("cloud.contributeCredential.apiKey", {
                    defaultValue: "API Key",
                  })}
                </Label>
                <Input
                  id="credential-api-key"
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={isSubmitting}
                  required
                  autoFocus
                  autoComplete="off"
                  className="bg-transparent border-[#303030] text-white font-mono"
                />
                <p className="text-xs font-mono text-white/40">
                  {t("cloud.contributeCredential.apiKeyHint", {
                    defaultValue:
                      "Validated with a live call before it enters the pool",
                  })}
                </p>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="credential-label"
                  className="text-white font-mono text-sm"
                >
                  {t("cloud.contributeCredential.label", {
                    defaultValue: "Label (optional)",
                  })}
                </Label>
                <Input
                  id="credential-label"
                  type="text"
                  placeholder={t(
                    "cloud.contributeCredential.labelPlaceholder",
                    { defaultValue: "e.g. work console key" },
                  )}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={120}
                  className="bg-transparent border-[#303030] text-white"
                />
              </div>

              <DialogFooter className="gap-2 sm:gap-0 flex flex-col sm:flex-row">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting}
                  className="px-4 py-2 text-white hover:bg-white/5 transition-colors disabled:opacity-50 order-2 sm:order-1"
                >
                  {t("cloud.contributeCredential.cancel", {
                    defaultValue: "Cancel",
                  })}
                </Button>
                <BrandButton
                  type="submit"
                  variant="primary"
                  disabled={isSubmitting}
                  className="font-mono text-sm order-1 sm:order-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("cloud.contributeCredential.validating", {
                        defaultValue: "Validating...",
                      })}
                    </>
                  ) : (
                    <>
                      <KeyRound className="h-4 w-4" />
                      {t("cloud.contributeCredential.submit", {
                        defaultValue: "Validate & Add",
                      })}
                    </>
                  )}
                </BrandButton>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
