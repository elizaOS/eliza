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
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { SemanticForm } from "../../components/ui/semantic-form";
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
      <DialogContent className="p-4 sm:p-6 max-w-[95vw] sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-txt-strong font-mono">
                <ShieldCheck className="size-5 text-status-success" />
                {t("cloud.contributeCredential.pooledTitle", {
                  defaultValue: "Key Added to the Pool",
                })}
              </DialogTitle>
              <DialogDescription className="text-muted font-mono text-xs md:text-sm">
                {t("cloud.contributeCredential.pooledDescription", {
                  provider: POOLED_PROVIDER_LABELS[provider],
                  defaultValue:
                    "Your {{provider}} key passed live validation and is encrypted in the org vault. It's never shown again in the dashboard — everyone sees just the last 4 characters.",
                })}
              </DialogDescription>
            </DialogHeader>

            <Card variant="insetPadded">
              <code className="text-xs font-mono text-txt-strong">
                {t("cloud.contributeCredential.maskedAs", {
                  last4: result.last4,
                  defaultValue: "Listed in the pool as ••••{{last4}}",
                })}
              </code>
            </Card>

            <DialogFooter>
              <Button
                type="button"
                variant="default"
                onClick={handleClose}
                className="font-mono text-sm"
              >
                {t("cloud.contributeCredential.done", {
                  defaultValue: "Done",
                })}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-txt-strong font-mono">
                <KeyRound className="size-5 text-muted" />
                {t("cloud.contributeCredential.title", {
                  defaultValue: "Contribute an API Key",
                })}
              </DialogTitle>
              <DialogDescription className="text-muted font-mono text-xs md:text-sm">
                {t("cloud.contributeCredential.description", {
                  defaultValue:
                    "Add a provider API key to your organization's shared pool. The key is validated live against the provider, then encrypted — nobody can ever read it back.",
                })}
              </DialogDescription>
            </DialogHeader>

            <SemanticForm onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <Alert variant="dashboardError" className="flex p-3">
                  <AlertCircle className="size-4 text-danger shrink-0 mt-0.5" />
                  <p className="text-xs md:text-sm font-mono text-danger">
                    {error}
                  </p>
                </Alert>
              )}

              <div className="space-y-2">
                <Label
                  htmlFor="credential-provider"
                  className="text-txt-strong font-mono text-sm"
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
                  <SelectTrigger id="credential-provider" variant="form">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent variant="form">
                    {POOLED_PROVIDERS.map((id) => (
                      <SelectItem key={id} value={id}>
                        <span className="font-mono text-txt-strong">
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
                  className="text-txt-strong font-mono text-sm"
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
                  variant="form"
                  className="font-mono"
                />
                <p className="text-xs font-mono text-muted">
                  {t("cloud.contributeCredential.apiKeyHint", {
                    defaultValue:
                      "Validated with a live call before it enters the pool",
                  })}
                </p>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="credential-label"
                  className="text-txt-strong font-mono text-sm"
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
                  variant="form"
                />
              </div>

              <DialogFooter className="gap-2 sm:gap-0 flex flex-col sm:flex-row">
                <Button
                  variant="ghostMuted"
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting}
                  className="order-2 sm:order-1"
                >
                  {t("cloud.contributeCredential.cancel", {
                    defaultValue: "Cancel",
                  })}
                </Button>
                <Button
                  type="submit"
                  variant="default"
                  disabled={isSubmitting}
                  className="font-mono text-sm order-1 sm:order-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t("cloud.contributeCredential.validating", {
                        defaultValue: "Validating...",
                      })}
                    </>
                  ) : (
                    <>
                      <KeyRound className="size-4" />
                      {t("cloud.contributeCredential.submit", {
                        defaultValue: "Validate & Add",
                      })}
                    </>
                  )}
                </Button>
              </DialogFooter>
            </SemanticForm>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
