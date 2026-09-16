/**
 * Presents the direct GitHub skill installer used by full-page and modal skill
 * views, with installation delegated to the authenticated agent API.
 */

import { useAgentElement } from "../../agent-surface";
import { useAppSelector } from "../../state";
import {
  AdminDialogContent,
  AdminDialogHeader,
  AdminInput,
} from "../ui/admin-dialog";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogTitle } from "../ui/dialog";

export function InstallModal({
  githubUrl,
  error,
  installing,
  onGithubUrlChange,
  onInstall,
  onClose,
}: {
  githubUrl: string;
  error: string;
  installing: boolean;
  onGithubUrlChange: (value: string) => void;
  onInstall: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useAppSelector((state) => state.t);
  const input = useAgentElement<HTMLInputElement>({
    id: "skill-install-url-input",
    role: "text-input",
    label: "GitHub repository URL",
    group: "skill-install",
    description: "Paste a GitHub repository URL to install a skill",
    getValue: () => githubUrl,
    onFill: onGithubUrlChange,
  });
  const submit = useAgentElement<HTMLButtonElement>({
    id: "skill-install-url-submit",
    role: "button",
    label: "Install from GitHub URL",
    group: "skill-install",
    description: "Install a skill from the entered GitHub repository URL",
    onActivate: () => void onInstall(),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <AdminDialogContent
        container={typeof document !== "undefined" ? document.body : undefined}
        className="max-w-xl"
      >
        <AdminDialogHeader>
          <DialogTitle className="text-sm font-extrabold uppercase tracking-[0.14em]">
            {t("skillsview.installSkillTitle", {
              defaultValue: "Install Skill",
            })}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs-tight text-muted">
            Install a skill directly from a GitHub repository. It will be
            security-scanned before activation.
          </DialogDescription>
        </AdminDialogHeader>
        <div className="px-5 py-4">
          <div className="mb-1 text-xs font-semibold text-txt">
            {t("skillsview.githubRepositoryUrl", {
              defaultValue: "GitHub Repository URL",
            })}
          </div>
          <div className="mb-3 text-xs-tight text-muted">
            {t("skillsview.githubRepositoryDesc", {
              defaultValue:
                "Paste a full GitHub repository URL to install a skill directly.",
            })}
          </div>
          <div className="flex items-center gap-2">
            <AdminInput
              ref={input.ref}
              type="url"
              className="flex-1"
              placeholder="https://github.com/org/repo"
              aria-label="GitHub repository URL"
              value={githubUrl}
              onChange={(event) => onGithubUrlChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && githubUrl.trim() && !installing) {
                  void onInstall();
                }
              }}
              {...input.agentProps}
            />
            <Button
              ref={submit.ref}
              size="sm"
              disabled={installing || !githubUrl.trim()}
              onClick={() => void onInstall()}
              {...submit.agentProps}
            >
              {installing
                ? t("common.installing", { defaultValue: "Installing..." })
                : t("common.install")}
            </Button>
          </div>
          {error && (
            <Alert variant="inlineDanger" className="mt-3 font-sans">
              {error}
            </Alert>
          )}
        </div>
      </AdminDialogContent>
    </Dialog>
  );
}
