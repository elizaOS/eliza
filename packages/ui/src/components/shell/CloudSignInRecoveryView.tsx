/** Keeps Cloud authentication failures inside the full-screen sign-in flow. */

import { Cloud } from "lucide-react";
import { useAppSelector } from "../../state";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";

interface CloudSignInRecoveryViewProps {
  detail?: string;
  busy?: boolean;
  onRetry: () => void;
}

export function CloudSignInRecoveryView({
  detail,
  busy = false,
  onRetry,
}: CloudSignInRecoveryViewProps) {
  const t = useAppSelector((state) => state.t);
  const hasFailure = Boolean(detail?.trim());

  return (
    <Card
      asChild
      variant="sandboxFrame"
      className="relative flex min-h-screen w-full items-center justify-center overflow-hidden px-4 py-6 font-body text-txt sm:px-6"
    >
      <main data-testid="cloud-sign-in-recovery">
        <Card
          surface="cardOverlay"
          border="subtle"
          className="relative z-10 w-full max-w-[560px] overflow-hidden"
        >
          <CardHeader className="pb-5 pt-6">
            <div className="flex flex-col gap-4">
              <Badge
                asChild
                variant="default"
                size="providerMark"
                aria-label={t("cloudsigninrecovery.CloudSignIn", {
                  defaultValue: "Eliza Cloud sign in",
                })}
                className="size-9"
                role="img"
              >
                <span>
                  <Cloud className="size-5" aria-hidden />
                </span>
              </Badge>
              <h1 className="text-xl font-semibold leading-tight text-txt">
                {t("cloudsigninrecovery.Title", {
                  defaultValue: "Sign in to Eliza Cloud",
                })}
              </h1>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-5 pt-5">
            <p className="text-sm leading-relaxed text-muted">
              {hasFailure
                ? t("cloudsigninrecovery.Description", {
                    defaultValue:
                      "We couldn't finish signing you in. Try again to continue to your agent.",
                  })
                : t("cloudsigninrecovery.InitialDescription", {
                    defaultValue:
                      "Sign in to connect your Eliza Cloud account. You'll return here when it's ready.",
                  })}
            </p>
            {hasFailure ? (
              <p
                className="rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm leading-relaxed text-txt"
                role="status"
              >
                {detail}
              </p>
            ) : null}
            <Button
              variant="default"
              size="lg"
              onClick={onRetry}
              disabled={busy}
              className="w-full sm:w-auto sm:min-w-[11rem]"
              data-testid="cloud-sign-in-retry"
            >
              {busy
                ? t("cloudsigninrecovery.Opening", {
                    defaultValue: "Opening secure sign in…",
                  })
                : hasFailure
                  ? t("cloudsigninrecovery.SignInAgain", {
                      defaultValue: "Sign in again",
                    })
                  : t("cloudsigninrecovery.SignIn", {
                      defaultValue: "Sign in to Eliza Cloud",
                    })}
            </Button>
          </CardContent>
        </Card>
      </main>
    </Card>
  );
}
