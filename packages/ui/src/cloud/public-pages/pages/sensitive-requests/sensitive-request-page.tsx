/**
 * Hosted public page for a sensitive-request submission (secret / private_info
 * / payment / oauth). Reads the form spec from /api/v1/sensitive-requests/:id
 * (with the URL token actor) and submits the value(s) via /submit. Renders
 * WITHOUT app-shell chrome.
 */

import { AlertCircle, CheckCircle2, Loader2, LockKeyhole } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation, useParams } from "react-router-dom";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Input,
  Textarea,
} from "../../../../components/primitives";
import { ApiError, api } from "../../../lib/api-client";
import { usePageTitle } from "../../lib/use-page-title";

type SensitiveRequestStatus =
  | "pending"
  | "fulfilled"
  | "failed"
  | "canceled"
  | "expired";
type SensitiveRequestKind = "secret" | "private_info" | "payment" | "oauth";

interface SensitiveRequestField {
  name: string;
  label: string;
  input: "secret" | "text" | "email" | "url" | "image" | "file";
  required: boolean;
  /** For `input: "image" | "file"` — accepted MIME types (file input `accept`). */
  mimeTypes?: string[];
  /** For `input: "image" | "file"` — max upload size in bytes. */
  maxBytes?: number;
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
    fields?: Array<{ name: string; label?: string; required?: boolean }>;
  };
  form?: {
    fields?: SensitiveRequestField[];
    submitLabel?: string;
  };
}

type LoadResponse =
  | HostedSensitiveRequest
  | { request: HostedSensitiveRequest };

function normalizeRequest(payload: LoadResponse): HostedSensitiveRequest {
  return "request" in payload ? payload.request : payload;
}

function normalizeError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This request link is unavailable.";
  }
  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  ) {
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

function fieldsForRequest(
  request: HostedSensitiveRequest,
): SensitiveRequestField[] {
  if (Array.isArray(request.form?.fields) && request.form.fields.length > 0) {
    return request.form.fields.filter(
      (field) =>
        typeof field.name === "string" &&
        typeof field.label === "string" &&
        (field.input === "secret" ||
          field.input === "text" ||
          field.input === "email" ||
          field.input === "url" ||
          field.input === "image" ||
          field.input === "file"),
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

  if (
    request.kind === "private_info" &&
    Array.isArray(request.target?.fields)
  ) {
    return request.target.fields
      .filter(
        (field) => typeof field.name === "string" && field.name.length > 0,
      )
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
  // Image/file fields can't ride FormData as a string, so their base64 data URL
  // is held in controlled state keyed by field name. #8910
  const [fileValues, setFileValues] = useState<Record<string, string>>({});

  usePageTitle("Sensitive Request | Eliza Cloud");

  const requestBasePath = useMemo(() => {
    if (!requestId) return null;
    return `/api/v1/sensitive-requests/${encodeURIComponent(requestId)}`;
  }, [requestId]);
  const requestPath = useMemo(
    () => (requestBasePath ? `${requestBasePath}${location.search}` : null),
    [requestBasePath, location.search],
  );
  const submitPath = useMemo(
    () =>
      requestBasePath ? `${requestBasePath}/submit${location.search}` : null,
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

  const fields = useMemo(
    () => (request ? fieldsForRequest(request) : []),
    [request],
  );
  const effectiveStatus: SensitiveRequestStatus | "success" = submitted
    ? "success"
    : request && hasExpired(request)
      ? "expired"
      : (request?.status ?? "pending");
  const copy = statusCopy(effectiveStatus);
  // A required image/file field can't be validated by the browser's native
  // `required` (its value lives in `fileValues`, populated async by FileReader),
  // so gate submit on every required upload having been read. #8910
  const hasRequiredUploads = fields.every(
    (field) =>
      (field.input !== "image" && field.input !== "file") ||
      !field.required ||
      Boolean(fileValues[field.name]),
  );
  const canSubmit = Boolean(
    request && effectiveStatus === "pending" && fields.length > 0,
  );
  const submitLabel = request?.form?.submitLabel || "Submit";

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!submitPath || !request || !canSubmit) return;

      const form = event.currentTarget;
      const formData = new FormData(form);
      const values: Record<string, string> = {};
      for (const field of fields) {
        const isUpload = field.input === "image" || field.input === "file";
        const rawValue = isUpload
          ? (fileValues[field.name] ?? "")
          : formData.get(field.name);
        const textValue = typeof rawValue === "string" ? rawValue : "";
        if (field.required && !textValue.trim()) {
          setError(
            isUpload
              ? "Attach the requested file before submitting."
              : "Fill out the required fields before submitting.",
          );
          return;
        }
        if (textValue) values[field.name] = textValue;
      }

      form.reset();
      setFileValues({});
      setSubmitting(true);
      setError(null);
      try {
        const firstValue = Object.values(values)[0] ?? "";
        const token =
          new URLSearchParams(location.search).get("token") ?? undefined;
        await api(submitPath, {
          method: "POST",
          skipAuth: true,
          json:
            request.kind === "secret"
              ? { token, value: firstValue }
              : { token, fields: values },
        });
        setSubmitted(true);
      } catch {
        setError(
          "Could not submit this request. Re-enter the value and try again.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, fields, fileValues, location.search, request, submitPath],
  );

  if (loading) {
    return (
      <div className="theme-cloud flex min-h-[100dvh] items-center justify-center bg-bg p-4">
        <Loader2 className="h-8 w-8 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="theme-cloud flex min-h-[100dvh] items-center justify-center bg-bg px-4 py-6 text-txt">
      <main
        id="main"
        className="w-full max-w-[520px] border border-border bg-card p-5"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-bg-elevated">
            {effectiveStatus === "success" ||
            effectiveStatus === "fulfilled" ? (
              <CheckCircle2 className="h-4 w-4 text-status-success" />
            ) : effectiveStatus === "pending" ? (
              <LockKeyhole className="h-4 w-4 text-accent" />
            ) : (
              <AlertCircle className="h-4 w-4 text-destructive" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
              Eliza Cloud
            </p>
            <h1 className="mt-1 text-lg font-semibold">{copy.title}</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {copy.body}
            </p>
          </div>
        </div>

        {request?.reason ? (
          <div className="mt-5 border border-border bg-surface px-3 py-2 text-sm text-muted">
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
          <form
            className="mt-5 space-y-4"
            onSubmit={handleSubmit}
            autoComplete="off"
          >
            {fields.map((field) => {
              const isUpload =
                field.input === "image" || field.input === "file";
              const type = field.input === "secret" ? "password" : field.input;
              const useTextarea =
                field.input === "text" && field.name.length > 24;
              const inputId = `field-${field.name}`;
              if (isUpload) {
                const accept =
                  field.mimeTypes && field.mimeTypes.length > 0
                    ? field.mimeTypes.join(",")
                    : field.input === "image"
                      ? "image/*"
                      : undefined;
                const hasValue = Boolean(fileValues[field.name]);
                return (
                  <label
                    htmlFor={inputId}
                    className="block space-y-2"
                    key={field.name}
                  >
                    <span className="text-sm font-medium text-muted-strong">
                      {field.label}
                    </span>
                    <Input
                      id={inputId}
                      name={field.name}
                      data-testid={`sensitive-request-file-${field.name}`}
                      type="file"
                      accept={accept}
                      // Mobile: prefer the rear camera for image capture (2FA QR/seed).
                      capture={
                        field.input === "image" ? "environment" : undefined
                      }
                      required={field.required && !hasValue}
                      disabled={submitting}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (!file) {
                          setFileValues((prev) => {
                            const next = { ...prev };
                            delete next[field.name];
                            return next;
                          });
                          return;
                        }
                        if (field.maxBytes && file.size > field.maxBytes) {
                          setFileValues((prev) => {
                            const next = { ...prev };
                            delete next[field.name];
                            return next;
                          });
                          setError(
                            `${field.label} is too large (max ${Math.round(
                              field.maxBytes / 1024,
                            )} KB).`,
                          );
                          event.currentTarget.value = "";
                          return;
                        }
                        const reader = new FileReader();
                        reader.onload = () => {
                          setError(null);
                          setFileValues((prev) => ({
                            ...prev,
                            [field.name]: String(reader.result ?? ""),
                          }));
                        };
                        reader.onerror = () => {
                          setFileValues((prev) => {
                            const next = { ...prev };
                            delete next[field.name];
                            return next;
                          });
                          setError(`Could not read ${field.label}.`);
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                );
              }
              return (
                <label
                  htmlFor={inputId}
                  className="block space-y-2"
                  key={field.name}
                >
                  <span className="text-sm font-medium text-muted-strong">
                    {field.label}
                  </span>
                  {useTextarea ? (
                    <Textarea
                      id={inputId}
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
                      id={inputId}
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
            <Button
              className="w-full"
              type="submit"
              disabled={submitting || !hasRequiredUploads}
            >
              {submitting ? "Submitting..." : submitLabel}
            </Button>
          </form>
        ) : null}
      </main>
    </div>
  );
}
