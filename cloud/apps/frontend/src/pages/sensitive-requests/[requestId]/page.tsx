import { Alert, AlertDescription, AlertTitle, Button, Input, Textarea } from "@elizaos/cloud-ui";
import { AlertCircle, CheckCircle2, Loader2, LockKeyhole } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { ApiError, api } from "../../../lib/api-client";

type SensitiveRequestStatus = "pending" | "fulfilled" | "failed" | "canceled" | "expired";
type SensitiveRequestKind = "secret" | "private_info" | "payment" | "oauth";

interface SensitiveRequestField {
  name: string;
  label: string;
  input: "secret" | "text" | "email" | "url";
  required: boolean;
}

interface HostedSensitiveRequest {
  id: string;
  kind: SensitiveRequestKind;
  status: SensitiveRequestStatus;
  reason?: string | null;
  expiresAt?: string | null;
  target?: {
    kind?: SensitiveRequestKind;
    key?: string;
    fields?: Array<{
      name: string;
      label?: string;
      required?: boolean;
    }>;
  };
  form?: {
    fields?: SensitiveRequestField[];
    submitLabel?: string;
  };
}

type LoadResponse = HostedSensitiveRequest | { request: HostedSensitiveRequest };

function normalizeRequest(payload: LoadResponse): HostedSensitiveRequest {
  return "request" in payload ? payload.request : payload;
}

function normalizeError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This request link is unavailable.";
  }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return "This request link requires authorization.";
  }
  return "Unable to load this request.";
}

function hasExpired(request: HostedSensitiveRequest): boolean {
  if (request.status === "expired") return true;
  if (!request.expiresAt) return false;
  const expiresAt = Date.parse(request.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function fieldsForRequest(request: HostedSensitiveRequest): SensitiveRequestField[] {
  if (Array.isArray(request.form?.fields) && request.form.fields.length > 0) {
    return request.form.fields.filter(
      (field) =>
        typeof field.name === "string" &&
        typeof field.label === "string" &&
        (field.input === "secret" ||
          field.input === "text" ||
          field.input === "email" ||
          field.input === "url"),
    );
  }

  if (request.kind === "secret" && request.target?.key) {
    return [
      {
        name: request.target.key,
        label: request.target.key,
        input: "secret",
        required: true,
      },
    ];
  }

  if (request.kind === "private_info" && Array.isArray(request.target?.fields)) {
    return request.target.fields
      .filter((field) => typeof field.name === "string" && field.name.length > 0)
      .map((field) => ({
        name: field.name,
        label: field.label || field.name,
        input: "text" as const,
        required: field.required !== false,
      }));
  }

  return [];
}

function statusCopy(status: SensitiveRequestStatus | "success"): {
  title: string;
  body: string;
  tone: "default" | "destructive";
} {
  switch (status) {
    case "success":
    case "fulfilled":
      return {
        title: "Request complete",
        body: "The value was submitted. This page will not show it again.",
        tone: "default",
      };
    case "expired":
      return {
        title: "Request expired",
        body: "Ask for a fresh request link to continue.",
        tone: "destructive",
      };
    case "canceled":
      return {
        title: "Request canceled",
        body: "This request is no longer accepting submissions.",
        tone: "destructive",
      };
    case "failed":
      return {
        title: "Request failed",
        body: "Ask for a fresh request link to continue.",
        tone: "destructive",
      };
    case "pending":
    default:
      return {
        title: "Sensitive request",
        body: "Submit the requested value through this form only.",
        tone: "default",
      };
  }
}

export default function SensitiveRequestPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const location = useLocation();
  const [request, setRequest] = useState<HostedSensitiveRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const requestBasePath = useMemo(() => {
    if (!requestId) return null;
    return `/api/v1/sensitive-requests/${encodeURIComponent(requestId)}`;
  }, [requestId]);
  const requestPath = useMemo(
    () => (requestBasePath ? `${requestBasePath}${location.search}` : null),
    [requestBasePath, location.search],
  );
  const submitPath = useMemo(
    () => (requestBasePath ? `${requestBasePath}/submit${location.search}` : null),
    [requestBasePath, location.search],
  );

  const loadRequest = useCallback(async () => {
    if (!requestPath) {
      setError("Request link is missing an id.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const payload = await api<LoadResponse>(requestPath, { skipAuth: true });
      setRequest(normalizeRequest(payload));
    } catch (loadError) {
      setError(normalizeError(loadError));
    } finally {
      setLoading(false);
    }
  }, [requestPath]);

  useEffect(() => {
    void loadRequest();
  }, [loadRequest]);

  const fields = useMemo(() => (request ? fieldsForRequest(request) : []), [request]);
  const effectiveStatus: SensitiveRequestStatus | "success" = submitted
    ? "success"
    : request && hasExpired(request)
      ? "expired"
      : (request?.status ?? "pending");
  const copy = statusCopy(effectiveStatus);
  const canSubmit = Boolean(request && effectiveStatus === "pending" && fields.length > 0);
  const submitLabel = request?.form?.submitLabel || "Submit";

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!submitPath || !request || !canSubmit) return;

      const form = event.currentTarget;
      const formData = new FormData(form);
      const values: Record<string, string> = {};
      for (const field of fields) {
        const value = formData.get(field.name);
        const textValue = typeof value === "string" ? value : "";
        if (field.required && !textValue.trim()) {
          setError("Fill out the required fields before submitting.");
          return;
        }
        if (textValue) values[field.name] = textValue;
      }

      form.reset();
      setSubmitting(true);
      setError(null);
      try {
        const firstValue = Object.values(values)[0] ?? "";
        const token = new URLSearchParams(location.search).get("token") ?? undefined;
        await api(submitPath, {
          method: "POST",
          skipAuth: true,
          json:
            request.kind === "secret" ? { token, value: firstValue } : { token, fields: values },
        });
        setSubmitted(true);
      } catch {
        setError("Could not submit this request. Re-enter the value and try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, fields, location.search, request, submitPath],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080A0D] p-4">
        <Loader2 className="h-8 w-8 animate-spin text-white/60" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#080A0D] px-4 py-6 text-white">
      <main className="w-full max-w-[520px] border border-white/10 bg-black/55 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-white/10 bg-white/5">
            {effectiveStatus === "success" || effectiveStatus === "fulfilled" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-300" />
            ) : effectiveStatus === "pending" ? (
              <LockKeyhole className="h-4 w-4 text-[#FF8A47]" />
            ) : (
              <AlertCircle className="h-4 w-4 text-red-300" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/45">
              Eliza Cloud
            </p>
            <h1 className="mt-1 text-lg font-semibold">{copy.title}</h1>
            <p className="mt-1 text-sm leading-relaxed text-white/60">{copy.body}</p>
          </div>
        </div>

        {request?.reason ? (
          <div className="mt-5 border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/70">
            {request.reason}
          </div>
        ) : null}

        {error ? (
          <Alert className="mt-5" variant="destructive">
            <AlertCircle />
            <AlertTitle>Request issue</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {canSubmit ? (
          <form className="mt-5 space-y-4" onSubmit={handleSubmit} autoComplete="off">
            {fields.map((field) => {
              const type = field.input === "secret" ? "password" : field.input;
              const useTextarea = field.input === "text" && field.name.length > 24;
              return (
                <label className="block space-y-2" key={field.name}>
                  <span className="text-sm font-medium text-white/85">{field.label}</span>
                  {useTextarea ? (
                    <Textarea
                      name={field.name}
                      required={field.required}
                      disabled={submitting}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  ) : (
                    <Input
                      name={field.name}
                      type={type}
                      required={field.required}
                      disabled={submitting}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  )}
                </label>
              );
            })}
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? "Submitting..." : submitLabel}
            </Button>
          </form>
        ) : null}
      </main>
    </div>
  );
}
