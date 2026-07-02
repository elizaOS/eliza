/**
 * Invite-acceptance page for organization invitations. Validates the token,
 * then lets an authenticated user accept (which MOVES them into the inviting org
 * — single-org model). Signed-out users are sent to login with a returnTo back
 * here. Ported from `@elizaos/cloud-frontend/src/pages/invite/accept/page.tsx`.
 *
 * Changes vs source: dropped the dead `pending-invite-token` localStorage write
 * (the returnTo round-trip already carries the token); raw fetch → typed `api`
 * client; `date-fns` format → `Intl.DateTimeFormat` (no date-fns dep here).
 *
 * Connect-link intent (#11332 design §5): when the link carries `connect=1`,
 * accepting routes straight to the org Credentials tab with the contribute
 * modal open (`/dashboard/organization?tab=credentials&contribute=1`) so the
 * teammate can pool their API key immediately. The param is preserved through
 * the login returnTo round-trip.
 */

import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  Shield,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../components/primitives";
import { ApiError, api } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { DEFAULT_LOGIN_RETURN_TO } from "../../lib/login-return-to";
import { useSessionAuth } from "../../lib/use-session-auth";

interface InviteDetails {
  organization_name: string;
  invited_email: string;
  role: string;
  expires_at: string;
  inviter_name: string | null;
}

interface InviteValidateResponse {
  success: boolean;
  data?: InviteDetails;
  error?: string;
}

interface InviteAcceptResponse {
  success: boolean;
  error?: string;
}

function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function InviteAcceptPage() {
  const t = useCloudT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { authenticated } = useSessionAuth();
  const token = searchParams.get("token");
  const connectIntent = searchParams.get("connect") === "1";

  const [isValidating, setIsValidating] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [inviteDetails, setInviteDetails] = useState<InviteDetails | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError(
        t("cloud.invite.noToken", {
          defaultValue: "No invitation token provided",
        }),
      );
      setIsValidating(false);
      return;
    }

    let cancelled = false;
    setIsValidating(true);
    api<InviteValidateResponse>(
      `/api/invites/validate?token=${encodeURIComponent(token)}`,
      { skipAuth: true },
    )
      .then((data) => {
        if (cancelled) return;
        if (data.success && data.data) {
          setInviteDetails(data.data);
          setError(null);
        } else {
          setError(
            data.error ||
              t("cloud.invite.invalidOrExpired", {
                defaultValue: "Invalid or expired invitation",
              }),
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : t("cloud.invite.invalidOrExpired", {
                defaultValue: "Invalid or expired invitation",
              }),
        );
      })
      .finally(() => {
        if (!cancelled) setIsValidating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, t]);

  const handleAcceptInvite = async () => {
    if (!authenticated) {
      const currentUrl = `/invite/accept?token=${encodeURIComponent(token ?? "")}${connectIntent ? "&connect=1" : ""}`;
      navigate(`/login?returnTo=${encodeURIComponent(currentUrl)}`);
      return;
    }

    setIsAccepting(true);
    try {
      const data = await api<InviteAcceptResponse>("/api/invites/accept", {
        method: "POST",
        json: { token },
      });
      if (data.success) {
        toast.success(
          t("cloud.invite.accepted", {
            defaultValue: "Invitation accepted! Redirecting…",
          }),
        );
        // connect=1 → land on the Credentials tab with the contribute modal
        // open so the new member can pool their API key immediately (#11332).
        const destination = connectIntent
          ? "/dashboard/organization?tab=credentials&contribute=1"
          : DEFAULT_LOGIN_RETURN_TO;
        setTimeout(() => navigate(destination), 1500);
      } else {
        setError(
          data.error ||
            t("cloud.invite.acceptFailed", {
              defaultValue: "Failed to accept invitation",
            }),
        );
        setIsAccepting(false);
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : t("cloud.invite.acceptFailed", {
              defaultValue: "Failed to accept invitation",
            }),
      );
      setIsAccepting(false);
    }
  };

  const getRoleIcon = (role: string) =>
    role === "admin" ? (
      <Shield className="h-4 w-4" />
    ) : (
      <User className="h-4 w-4" />
    );

  if (isValidating) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
            <CardTitle>
              {t("cloud.invite.validating", {
                defaultValue: "Validating Invitation",
              })}
            </CardTitle>
            <CardDescription>
              {t("cloud.invite.validatingDescription", {
                defaultValue: "Please wait while we verify your invitation...",
              })}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (error || !inviteDetails) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle role="heading" aria-level={1}>
              {t("cloud.invite.invalidTitle", {
                defaultValue: "Invalid Invitation",
              })}
            </CardTitle>
            <CardDescription>
              {error ||
                t("cloud.invite.invalidDescription", {
                  defaultValue:
                    "This invitation link is invalid or has expired",
                })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => navigate("/")}
              className="w-full"
            >
              {t("cloud.invite.goToHome", { defaultValue: "Go to Home" })}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const expiresAt = new Date(inviteDetails.expires_at);
  const isExpiringSoon = expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Mail className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl">
            {t("cloud.invite.youreInvited", {
              defaultValue: "You're Invited!",
            })}
          </CardTitle>
          <CardDescription>
            {t("cloud.invite.invitedToJoin", {
              defaultValue: "You've been invited to join an organization",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4 rounded-lg border bg-muted/50 p-4">
            <div className="flex items-start gap-3">
              <Building2 className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("cloud.invite.organization", {
                    defaultValue: "Organization",
                  })}
                </p>
                <p className="text-lg font-semibold">
                  {inviteDetails.organization_name}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Mail className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("cloud.invite.invitedEmail", {
                    defaultValue: "Invited Email",
                  })}
                </p>
                <p className="text-base font-medium">
                  {inviteDetails.invited_email}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              {getRoleIcon(inviteDetails.role)}
              <div className="flex-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("cloud.invite.role", { defaultValue: "Role" })}
                </p>
                <Badge
                  variant="outline"
                  className="mt-1 flex items-center gap-1 w-fit"
                >
                  {getRoleIcon(inviteDetails.role)}
                  <span className="capitalize">{inviteDetails.role}</span>
                </Badge>
              </div>
            </div>

            {inviteDetails.inviter_name && (
              <div className="flex items-start gap-3">
                <User className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {t("cloud.invite.invitedBy", {
                      defaultValue: "Invited by",
                    })}
                  </p>
                  <p className="text-base">{inviteDetails.inviter_name}</p>
                </div>
              </div>
            )}
          </div>

          {isExpiringSoon && (
            <Alert variant="destructive">
              <Clock className="h-4 w-4" />
              <AlertDescription>
                {t("cloud.invite.expiresOn", {
                  date: formatExpiry(inviteDetails.expires_at),
                  defaultValue: "This invitation expires on {{date}}",
                })}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-3">
            <Button
              onClick={handleAcceptInvite}
              disabled={isAccepting}
              className="w-full"
              size="lg"
            >
              {isAccepting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {authenticated
                    ? t("cloud.invite.accepting", {
                        defaultValue: "Accepting...",
                      })
                    : t("cloud.invite.redirectingToLogin", {
                        defaultValue: "Redirecting to Login...",
                      })}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  {authenticated
                    ? t("cloud.invite.acceptInvitation", {
                        defaultValue: "Accept Invitation",
                      })
                    : t("cloud.invite.signInToAccept", {
                        defaultValue: "Sign In to Accept",
                      })}
                </>
              )}
            </Button>

            <Button
              variant="outline"
              onClick={() => navigate("/")}
              disabled={isAccepting}
              className="w-full"
            >
              {t("cloud.invite.decline", { defaultValue: "Decline" })}
            </Button>
          </div>

          <div className="text-center text-xs text-muted-foreground">
            {t("cloud.invite.acceptingNote", {
              defaultValue:
                "By accepting, you'll gain access to the organization's resources and workspace.",
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
