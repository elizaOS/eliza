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
} from "@elizaos/cloud-ui";
import { format } from "date-fns";
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
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";

interface InviteDetails {
  organization_name: string;
  invited_email: string;
  role: string;
  expires_at: string;
  inviter_name: string | null;
}

function InviteAcceptContent() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { authenticated } = useSessionAuth();
  const token = searchParams.get("token");

  const [isValidating, setIsValidating] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [inviteDetails, setInviteDetails] = useState<InviteDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const validateInvite = async () => {
      setIsValidating(true);
      const response = await fetch(`/api/invites/validate?token=${encodeURIComponent(token!)}`);
      const data = await response.json();

      if (data.success) {
        setInviteDetails(data.data);
        setError(null);
      } else {
        setError(data.error || "Invalid or expired invitation");
      }
      setIsValidating(false);
    };

    if (!token) {
      setError("No invitation token provided");
      setIsValidating(false);
      return;
    }

    validateInvite();
  }, [token]);

  const handleAcceptInvite = async () => {
    if (!authenticated) {
      // Store the token in localStorage to retrieve after login (backup for OAuth flows)
      localStorage.setItem("pending-invite-token", token!);
      // Use returnTo to redirect back to this page after login
      const currentUrl = `/invite/accept?token=${encodeURIComponent(token!)}`;
      navigate(`/login?returnTo=${encodeURIComponent(currentUrl)}`);
      return;
    }

    setIsAccepting(true);
    const response = await fetch("/api/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const data = await response.json();

    if (data.success) {
      toast.success("Invitation accepted! Redirecting to dashboard...");
      setTimeout(() => {
        navigate("/dashboard");
      }, 1500);
    } else {
      setError(data.error || "Failed to accept invitation");
      setIsAccepting(false);
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "admin":
        return <Shield className="h-4 w-4" />;
      default:
        return <User className="h-4 w-4" />;
    }
  };

  if (isValidating) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
            <CardTitle>Validating Invitation</CardTitle>
            <CardDescription>Please wait while we verify your invitation...</CardDescription>
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
              Invalid Invitation
            </CardTitle>
            <CardDescription>
              {error || "This invitation link is invalid or has expired"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate("/")} className="w-full">
              Go to Home
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
          <CardTitle className="text-2xl">You&apos;re Invited!</CardTitle>
          <CardDescription>You&apos;ve been invited to join an organization</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4 rounded-lg border bg-muted/50 p-4">
            <div className="flex items-start gap-3">
              <Building2 className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-muted-foreground">Organization</p>
                <p className="text-lg font-semibold">{inviteDetails.organization_name}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Mail className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-muted-foreground">Invited Email</p>
                <p className="text-base font-medium">{inviteDetails.invited_email}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              {getRoleIcon(inviteDetails.role)}
              <div className="flex-1">
                <p className="text-sm font-medium text-muted-foreground">Role</p>
                <Badge variant="outline" className="mt-1 flex items-center gap-1 w-fit">
                  {getRoleIcon(inviteDetails.role)}
                  <span className="capitalize">{inviteDetails.role}</span>
                </Badge>
              </div>
            </div>

            {inviteDetails.inviter_name && (
              <div className="flex items-start gap-3">
                <User className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-muted-foreground">Invited by</p>
                  <p className="text-base">{inviteDetails.inviter_name}</p>
                </div>
              </div>
            )}
          </div>

          {isExpiringSoon && (
            <Alert variant="destructive">
              <Clock className="h-4 w-4" />
              <AlertDescription>
                This invitation expires on {format(expiresAt, "MMM d, yyyy 'at' h:mm a")}
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
                  {authenticated ? "Accepting..." : "Redirecting to Login..."}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  {authenticated ? "Accept Invitation" : "Sign In to Accept"}
                </>
              )}
            </Button>

            <Button
              variant="outline"
              onClick={() => navigate("/")}
              disabled={isAccepting}
              className="w-full"
            >
              Decline
            </Button>
          </div>

          <div className="text-center text-xs text-muted-foreground">
            By accepting, you&apos;ll gain access to the organization&apos;s resources and
            workspace.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Invite acceptance page for organization invitations.
 * Validates the invitation token and allows authenticated users to accept.
 * Redirects unauthenticated users to login first.
 */
export default function InviteAcceptPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
              <CardTitle>Loading Invitation</CardTitle>
              <CardDescription>Please wait...</CardDescription>
            </CardHeader>
          </Card>
        </div>
      }
    >
      <InviteAcceptContent />
    </Suspense>
  );
}
