/**
 * Project-owned Cloud publication surface for first publish and ongoing care.
 *
 * It keeps the local project as the durable object, derives publication state
 * live from Cloud, and embeds the complete existing Cloud management suite
 * after publish. Signed-out, loading, empty, offline, and failed states are
 * explicit so no missing backend is presented as a healthy unpublished project.
 */

import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  FileUp,
  FolderUp,
  Globe2,
  Loader2,
  RefreshCw,
  Rocket,
  Server,
} from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ProjectSummary } from "../../../api/client-types-cloud";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { CopyButton } from "../../../components/ui/copy-button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Textarea } from "../../../components/ui/textarea";
import { useAppSelectorShallow } from "../../../state";
import { formatUsd } from "../../lib/format-usd";
import { CloudSettingsSectionShell } from "../../settings/CloudSettingsSectionShell";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  type AppDeployCapability,
  getAppDeployCapability,
  updateApp,
  validateDeployAppInput,
} from "../lib/apps";
import { filesToBundle } from "../lib/frontend-hosting";
import { openExternalUrlOnNative } from "../lib/native-cloud-nav";
import { storeOneTimeAppApiKey } from "../lib/one-time-app-api-key";
import {
  notifyProjectPublicationChanged,
  useProjectPublication,
} from "../lib/project-publication";
import {
  deletePublishedProject,
  type ProjectPublishMode,
  publishProject,
  unbindLocalProjectCloudApp,
  unpublishProject,
} from "../lib/project-publish-workflow";
import {
  getPublishingAccountData,
  type PublishingAccountData,
  publishingAffiliateUrl,
} from "../lib/publishing-account";
import { AppDetailsTabs, type AppDetailsTabValue } from "./app-details-tabs";

export interface ProjectPublishPanelProps {
  project: ProjectSummary;
  onProjectChanged?: (project: ProjectSummary) => void;
}

type PublishingAccountState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: PublishingAccountData };

function CloudConnectionGate(): React.JSX.Element {
  const { busy, handleCloudLogin, setActionNotice, t } = useAppSelectorShallow(
    (state) => ({
      busy: state.elizaCloudLoginBusy,
      handleCloudLogin: state.handleCloudLogin,
      setActionNotice: state.setActionNotice,
      t: state.t,
    }),
  );

  const connect = useCallback(() => {
    void handleCloudLogin().catch((error: unknown) => {
      // error-policy:J4 sign-in launch failures surface in the shared notice UI.
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("projects.publish.connectFailed", {
              defaultValue: "Could not start Cloud sign-in.",
            }),
        "error",
        5_000,
      );
    });
  }, [handleCloudLogin, setActionNotice, t]);

  return (
    <section
      className="flex min-h-64 flex-col items-start justify-center gap-4 border border-border bg-card p-5 sm:p-8"
      data-testid="project-publish-connect"
    >
      <Cloud className="h-8 w-8 text-accent" aria-hidden />
      <div className="max-w-xl space-y-1">
        <h3 className="text-lg font-semibold text-txt-strong">
          {t("projects.publish.connectTitle", {
            defaultValue: "Connect Eliza Cloud to publish",
          })}
        </h3>
        <p className="text-sm text-muted">
          {t("projects.publish.connectDescription", {
            defaultValue:
              "Your project stays local until you connect. Cloud adds a public URL, managed hosting, domains, analytics, monetization, and payouts.",
          })}
        </p>
      </div>
      <Button onClick={connect} disabled={busy} className="min-h-11">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <Cloud className="h-4 w-4" aria-hidden />
        )}
        {busy
          ? t("projects.publish.connecting", {
              defaultValue: "Connecting...",
            })
          : t("projects.publish.connectCta", {
              defaultValue: "Connect Eliza Cloud",
            })}
      </Button>
    </section>
  );
}

function PublicationLoading(): React.JSX.Element {
  const t = useCloudT();
  return (
    <div
      className="flex min-h-52 items-center justify-center gap-3 border border-border bg-card text-sm text-muted"
      aria-busy="true"
      data-testid="project-publication-loading"
    >
      <Loader2 className="h-5 w-5 animate-spin text-accent" aria-hidden />
      {t("projects.publish.loading", {
        defaultValue: "Checking publication",
      })}
    </div>
  );
}

function PublishingAccountContext({
  appId,
}: {
  appId: string;
}): React.JSX.Element {
  const t = useCloudT();
  const [state, setState] = useState<PublishingAccountState>({
    status: "loading",
  });
  const [revision, setRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: appId remounts account context and revision is an explicit retry token.
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void getPublishingAccountData()
      .then((data) => {
        if (!current) return;
        setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        // error-policy:J4 account reads render an explicit unavailable state.
        if (!current) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load publishing account context",
        });
      });
    return () => {
      current = false;
    };
  }, [appId, revision]);

  if (state.status === "loading") {
    return (
      <div
        className="flex min-h-16 items-center gap-2 border-y border-border px-3 text-xs text-muted"
        aria-busy="true"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t("projects.publish.accountLoading", {
          defaultValue: "Loading publishing account details",
        })}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>
          {t("projects.publish.accountUnavailable", {
            defaultValue: "Account context unavailable",
          })}
        </AlertTitle>
        <AlertDescription>
          <p>{state.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t("common.retry", { defaultValue: "Retry" })}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const affiliate = state.data.affiliate;
  const affiliateUrl =
    affiliate && affiliate.isActive !== false
      ? publishingAffiliateUrl(affiliate.code)
      : null;
  return (
    <section
      className="grid gap-3 border-y border-border py-3 text-sm sm:grid-cols-2"
      aria-label={t("projects.publish.accountContext", {
        defaultValue: "Publishing account context",
      })}
    >
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {t("projects.publish.affiliateCode", {
            defaultValue: "Your affiliate code",
          })}
        </p>
        <p className="mt-1 font-mono text-txt">
          {affiliate
            ? affiliate.isActive === false
              ? t("projects.publish.affiliateInactive", {
                  defaultValue: "Not active",
                })
              : affiliate.code
            : t("projects.publish.affiliateNotConfigured", {
                defaultValue: "Not configured",
              })}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {t("projects.publish.redeemableBalance", {
            defaultValue: "Your redeemable balance",
          })}
        </p>
        <p className="mt-1 font-semibold text-txt">
          {formatUsd(state.data.availableBalance)}
        </p>
      </div>
      <div className="min-w-0 sm:col-span-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {t("projects.publish.affiliateLink", {
            defaultValue: "Your affiliate link",
          })}
        </p>
        {affiliateUrl ? (
          <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <code
              className="flex min-h-11 min-w-0 flex-1 items-center rounded-sm bg-surface px-3 text-xs text-txt"
              title={affiliateUrl}
            >
              <span className="truncate">{affiliateUrl}</span>
            </code>
            <div className="flex shrink-0 gap-2">
              <CopyButton
                value={affiliateUrl}
                copyLabel={t("projects.publish.copyAffiliateLink", {
                  defaultValue: "Copy affiliate link",
                })}
                copiedLabel={t("projects.publish.affiliateLinkCopied", {
                  defaultValue: "Affiliate link copied",
                })}
                className="min-h-11 border border-border bg-card px-3 text-muted-strong hover:bg-surface hover:text-txt"
              >
                <span className="text-sm font-medium">
                  {t("projects.publish.copyAffiliateLink", {
                    defaultValue: "Copy affiliate link",
                  })}
                </span>
              </CopyButton>
              <Button asChild variant="outline" size="sm" className="min-h-11">
                <a
                  href={affiliateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (openExternalUrlOnNative(affiliateUrl)) {
                      event.preventDefault();
                    }
                  }}
                  aria-label={t("projects.publish.openAffiliateLink", {
                    defaultValue: "Open affiliate link",
                  })}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  {t("common.open", { defaultValue: "Open" })}
                </a>
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted">
            {affiliate
              ? t("projects.publish.affiliateLinkInactive", {
                  defaultValue:
                    "This affiliate code is inactive, so its signup link is unavailable.",
                })
              : t("projects.publish.affiliateLinkUnavailable", {
                  defaultValue:
                    "Create an affiliate code in Monetization to get a shareable signup link.",
                })}
          </p>
        )}
      </div>
      <p className="text-xs text-muted sm:col-span-2">
        {t("projects.publish.affiliateGap", {
          defaultValue:
            "Affiliate attribution is account-wide. Project-scoped chat does not yet read X-Affiliate-Code.",
        })}
      </p>
    </section>
  );
}

interface PublishWizardProps {
  project: ProjectSummary;
  existingApp: ReturnType<typeof useProjectPublication>["app"];
  onCancel: () => void;
  onBound: (
    project: ProjectSummary,
    app: NonNullable<ReturnType<typeof useProjectPublication>["app"]>,
    apiKey: string | undefined,
  ) => void;
  onPublished: (project: ProjectSummary, apiKey: string | undefined) => void;
}

function PublishWizard({
  project,
  existingApp,
  onCancel,
  onBound,
  onPublished,
}: PublishWizardProps): React.JSX.Element {
  const t = useCloudT();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"details" | "hosting">("details");
  const [name, setName] = useState(existingApp?.name ?? project.name);
  const [description, setDescription] = useState(
    existingApp?.description ?? "",
  );
  const [mode, setMode] = useState<ProjectPublishMode>("managed-frontend");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? "");
  const [commitSha, setCommitSha] = useState("");
  const [dockerfile, setDockerfile] = useState("");
  const [capability, setCapability] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; value: AppDeployCapability }
  >({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boundProject, setBoundProject] = useState(project);
  const [boundApp, setBoundApp] = useState(existingApp);

  useEffect(() => {
    let current = true;
    void getAppDeployCapability()
      .then((value) => {
        if (current) setCapability({ status: "ready", value });
      })
      .catch((capabilityError: unknown) => {
        // error-policy:J4 capability failure disables container selection visibly.
        if (!current) return;
        setCapability({
          status: "error",
          message:
            capabilityError instanceof Error
              ? capabilityError.message
              : "Container capability could not be checked",
        });
      });
    return () => {
      current = false;
    };
  }, []);

  const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.length) return;
    setSelectedFiles(Array.from(event.target.files));
    setError(null);
  };
  const selectedBytes = selectedFiles.reduce(
    (total, file) => total + file.size,
    0,
  );
  const containerEnabled =
    capability.status === "ready" && capability.value.enabled;

  const continueToHosting = () => {
    if (!name.trim()) {
      setError(
        t("projects.publish.nameRequired", {
          defaultValue: "Project name is required",
        }),
      );
      return;
    }
    setError(null);
    setStep("hosting");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const frontendFiles =
        mode === "managed-frontend"
          ? await filesToBundle(selectedFiles)
          : undefined;
      const containerValidation =
        mode === "container"
          ? validateDeployAppInput({
              repoUrl,
              ref: commitSha,
              dockerfile,
            })
          : undefined;
      if (containerValidation && !containerValidation.ok) {
        throw new Error(containerValidation.error);
      }
      const result = await publishProject({
        project: boundProject,
        ...(boundApp ? { existingApp: boundApp } : {}),
        onBound: (binding) => {
          setBoundProject(binding.project);
          setBoundApp(binding.app);
          onBound(binding.project, binding.app, binding.apiKey);
        },
        name,
        description,
        mode,
        ...(frontendFiles ? { frontendFiles } : {}),
        ...(containerValidation?.ok
          ? { container: containerValidation.value }
          : {}),
      });
      onPublished(result.project, result.apiKey);
    } catch (publishError) {
      // error-policy:J4 the wizard preserves its inputs and renders the failure.
      setError(
        publishError instanceof Error
          ? publishError.message
          : t("projects.publish.failed", {
              defaultValue: "Project could not be published",
            }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="space-y-5 border border-border bg-card p-4 sm:p-5"
      data-testid="project-publish-wizard"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            {t("projects.publish.step", {
              defaultValue: "Step {{current}} of 2",
              current: step === "details" ? 1 : 2,
            })}
          </p>
          <h3 className="mt-1 text-lg font-semibold text-txt-strong">
            {step === "details"
              ? t("projects.publish.detailsTitle", {
                  defaultValue: "Describe the published project",
                })
              : t("projects.publish.hostingTitle", {
                  defaultValue: "Choose how it goes live",
                })}
          </h3>
        </div>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t("common.cancel", { defaultValue: "Cancel" })}
        </Button>
      </div>

      {step === "details" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`publish-name-${project.id}`}>
              {t("projects.publish.name", { defaultValue: "Name" })}
            </Label>
            <Input
              id={`publish-name-${project.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-h-11"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`publish-description-${project.id}`}>
              {t("projects.publish.description", {
                defaultValue: "Description",
              })}
            </Label>
            <Textarea
              id={`publish-description-${project.id}`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              placeholder={t("projects.publish.descriptionPlaceholder", {
                defaultValue: "What this project does and who it is useful for",
              })}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={continueToHosting} className="min-h-11">
              {t("common.continue", { defaultValue: "Continue" })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
            <Button
              type="button"
              variant="outline"
              role="radio"
              aria-checked={mode === "managed-frontend"}
              onClick={() => setMode("managed-frontend")}
              className={`min-h-20 justify-start whitespace-normal p-3 text-left ${
                mode === "managed-frontend"
                  ? "border-accent bg-accent-subtle"
                  : ""
              }`}
            >
              <Globe2 className="h-5 w-5 shrink-0 text-accent" aria-hidden />
              <span>
                <span className="block font-semibold">
                  {t("projects.publish.managedFrontend", {
                    defaultValue: "Managed frontend",
                  })}
                </span>
                <span className="block text-xs font-normal text-muted">
                  {t("projects.publish.managedFrontendHint", {
                    defaultValue:
                      "Recommended · upload a built static site, no container required",
                  })}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              role="radio"
              aria-checked={mode === "container"}
              disabled={!containerEnabled}
              onClick={() => setMode("container")}
              className={`min-h-20 justify-start whitespace-normal p-3 text-left ${
                mode === "container" ? "border-accent bg-accent-subtle" : ""
              }`}
            >
              <Server className="h-5 w-5 shrink-0" aria-hidden />
              <span>
                <span className="block font-semibold">
                  {t("projects.publish.container", {
                    defaultValue: "Container backend",
                  })}
                </span>
                <span className="block text-xs font-normal text-muted">
                  {containerEnabled
                    ? t("projects.publish.containerEnabled", {
                        defaultValue:
                          "Deploy server code from an immutable Git commit",
                      })
                    : t("projects.publish.containerUnavailable", {
                        defaultValue:
                          "Available when enabled for your organization",
                      })}
                </span>
              </span>
            </Button>
          </div>

          {capability.status === "error" ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>
                {t("projects.publish.containerCheckFailed", {
                  defaultValue: "Container availability could not be checked",
                })}
              </AlertTitle>
              <AlertDescription>{capability.message}</AlertDescription>
            </Alert>
          ) : null}

          {mode === "managed-frontend" ? (
            <div className="space-y-3">
              <Input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                data-testid="project-publish-folder-input"
                {...{ webkitdirectory: "" }}
                onChange={pickFiles}
              />
              <Input
                ref={filesInputRef}
                type="file"
                multiple
                className="hidden"
                data-testid="project-publish-files-input"
                onChange={pickFiles}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => folderInputRef.current?.click()}
                  disabled={busy}
                >
                  <FolderUp className="h-4 w-4" aria-hidden />
                  {t("projects.publish.selectFolder", {
                    defaultValue: "Select built folder",
                  })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => filesInputRef.current?.click()}
                  disabled={busy}
                >
                  <FileUp className="h-4 w-4" aria-hidden />
                  {t("projects.publish.selectFiles", {
                    defaultValue: "Select files",
                  })}
                </Button>
              </div>
              <p className="text-xs text-muted">
                {selectedFiles.length > 0
                  ? t("projects.publish.filesSelected", {
                      defaultValue: "{{count}} files · {{size}} KB",
                      count: selectedFiles.length,
                      size: Math.ceil(selectedBytes / 1024),
                    })
                  : t("projects.publish.filesHint", {
                      defaultValue:
                        "Choose output containing index.html (for example dist or build).",
                    })}
              </p>
            </div>
          ) : (
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor={`publish-repo-${project.id}`}>
                  {t("projects.publish.repository", {
                    defaultValue: "Git repository",
                  })}
                </Label>
                <Input
                  id={`publish-repo-${project.id}`}
                  type="url"
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/owner/project.git"
                  className="min-h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`publish-commit-${project.id}`}>
                  {t("projects.publish.commitSha", {
                    defaultValue: "Commit SHA",
                  })}
                </Label>
                <Input
                  id={`publish-commit-${project.id}`}
                  value={commitSha}
                  onChange={(event) => setCommitSha(event.target.value)}
                  placeholder="40-character immutable commit"
                  className="min-h-11 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`publish-dockerfile-${project.id}`}>
                  {t("projects.publish.dockerfile", {
                    defaultValue: "Dockerfile path (optional)",
                  })}
                </Label>
                <Input
                  id={`publish-dockerfile-${project.id}`}
                  value={dockerfile}
                  onChange={(event) => setDockerfile(event.target.value)}
                  placeholder="Dockerfile"
                  className="min-h-11 font-mono"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep("details")}
              disabled={busy}
              className="min-h-11"
            >
              {t("common.back", { defaultValue: "Back" })}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={
                busy ||
                (mode === "managed-frontend" && selectedFiles.length === 0) ||
                (mode === "container" && !containerEnabled)
              }
              className="min-h-11"
              data-testid="project-publish-submit"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Rocket className="h-4 w-4" aria-hidden />
              )}
              {busy
                ? t("projects.publish.publishing", {
                    defaultValue: "Publishing...",
                  })
                : t("projects.publish.publishCta", {
                    defaultValue: "Publish project",
                  })}
            </Button>
          </div>
        </div>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>
            {t("projects.publish.failedTitle", {
              defaultValue: "Publication failed",
            })}
          </AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function ProjectPublishPanelBody({
  project: initialProject,
  onProjectChanged,
}: ProjectPublishPanelProps): React.JSX.Element {
  const t = useCloudT();
  const [project, setProject] = useState(initialProject);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AppDetailsTabValue>("overview");
  const [showApiKey, setShowApiKey] = useState<string | undefined>();
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const publication = useProjectPublication(project, true);

  useEffect(() => {
    setProject(initialProject);
  }, [initialProject]);

  const commitProject = useCallback(
    (next: ProjectSummary) => {
      setProject(next);
      onProjectChanged?.(next);
    },
    [onProjectChanged],
  );

  const handlePublished = (
    nextProject: ProjectSummary,
    apiKey: string | undefined,
  ) => {
    commitProject(nextProject);
    if (apiKey && nextProject.cloudAppId) {
      storeOneTimeAppApiKey(nextProject.cloudAppId, apiKey);
      setShowApiKey(apiKey);
      setActiveTab("overview");
    }
    setWizardOpen(false);
    notifyProjectPublicationChanged(nextProject.id);
    publication.refresh();
  };

  const handleBound = (
    nextProject: ProjectSummary,
    app: NonNullable<ReturnType<typeof useProjectPublication>["app"]>,
    apiKey: string | undefined,
  ) => {
    commitProject(nextProject);
    if (apiKey) {
      storeOneTimeAppApiKey(app.id, apiKey);
      setShowApiKey(apiKey);
    }
  };

  const handleRepublish = async () => {
    if (!publication.app) return;
    if (!publication.liveMode) {
      setWizardOpen(true);
      return;
    }
    setOperationBusy(true);
    setOperationError(null);
    try {
      await updateApp(publication.app.id, { is_active: true });
      notifyProjectPublicationChanged(project.id);
      publication.refresh();
    } catch (error) {
      // error-policy:J4 republish failures stay visible in the management panel.
      setOperationError(
        error instanceof Error ? error.message : "Could not republish project",
      );
    } finally {
      setOperationBusy(false);
    }
  };

  const handleUnpublish = async () => {
    if (!publication.app) return;
    await unpublishProject(publication.app.id);
    notifyProjectPublicationChanged(project.id);
    publication.refresh();
  };

  const handleDelete = async () => {
    if (!publication.app) return;
    const next = await deletePublishedProject(project.id, publication.app.id);
    commitProject(next);
    notifyProjectPublicationChanged(project.id);
    publication.refresh();
    setActiveTab("overview");
  };

  const handleClearStaleBinding = async () => {
    setOperationBusy(true);
    setOperationError(null);
    try {
      const next = await unbindLocalProjectCloudApp(project.id);
      commitProject(next);
      notifyProjectPublicationChanged(project.id);
      publication.refresh();
    } catch (error) {
      // error-policy:J4 stale-binding recovery failures remain actionable errors.
      setOperationError(
        error instanceof Error
          ? error.message
          : "Could not clear the stale Cloud binding",
      );
    } finally {
      setOperationBusy(false);
    }
  };

  if (publication.status === "loading") return <PublicationLoading />;

  if (wizardOpen) {
    return (
      <PublishWizard
        project={project}
        existingApp={publication.app}
        onCancel={() => setWizardOpen(false)}
        onBound={handleBound}
        onPublished={handlePublished}
      />
    );
  }

  if (publication.status === "error") {
    return (
      <div className="space-y-3">
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>
            {t("projects.publish.loadFailedTitle", {
              defaultValue: "Publication could not be loaded",
            })}
          </AlertTitle>
          <AlertDescription>
            <p>{publication.error}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={publication.refresh}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t("common.retry", { defaultValue: "Retry" })}
              </Button>
              {publication.app ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWizardOpen(true)}
                >
                  {t("projects.publish.finishCta", {
                    defaultValue: "Finish publishing",
                  })}
                </Button>
              ) : null}
              {publication.staleBinding ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={operationBusy}
                  onClick={() => void handleClearStaleBinding()}
                >
                  {t("projects.publish.clearStaleBinding", {
                    defaultValue: "Clear broken binding",
                  })}
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
        {operationError ? (
          <p className="text-sm text-destructive">{operationError}</p>
        ) : null}
      </div>
    );
  }

  const hasCloudRecord = Boolean(publication.app);
  if (!hasCloudRecord) {
    return (
      <section
        className="flex min-h-64 flex-col items-start justify-center gap-4 border border-border bg-card p-5 sm:p-8"
        data-testid="project-not-published"
      >
        <Rocket className="h-8 w-8 text-accent" aria-hidden />
        <div className="max-w-xl space-y-1">
          <h3 className="text-lg font-semibold text-txt-strong">
            {t("projects.publish.readyTitle", {
              defaultValue: "Ready to publish",
            })}
          </h3>
          <p className="text-sm text-muted">
            {t("projects.publish.readyDescription", {
              defaultValue:
                "Publish a built frontend to get a public URL now. You can add domains, monetization, analytics, users, and a container backend from the same project afterward.",
            })}
          </p>
        </div>
        <Button
          onClick={() => setWizardOpen(true)}
          className="min-h-11"
          data-testid="project-publish-open"
        >
          <Rocket className="h-4 w-4" aria-hidden />
          {t("projects.publish.publishCta", {
            defaultValue: "Publish project",
          })}
        </Button>
      </section>
    );
  }

  const app = publication.app;
  if (!app) return <PublicationLoading />;
  const isPublished = publication.status === "published";
  const needsDeployment = !publication.liveMode;

  return (
    <div className="space-y-5" data-testid="project-publication-management">
      <section className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-txt-strong">
              {app.name}
            </h3>
            <Badge
              variant={isPublished ? "outline" : "secondary"}
              className={
                isPublished
                  ? "border-status-success/40 bg-status-success-bg text-status-success"
                  : undefined
              }
            >
              {isPublished
                ? t("projects.publish.published", {
                    defaultValue: "Published",
                  })
                : t("projects.publish.unpublished", {
                    defaultValue: "Unpublished",
                  })}
            </Badge>
          </div>
          {publication.publicUrl ? (
            <a
              href={publication.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex max-w-full items-center gap-1 text-sm text-accent hover:text-accent-hover"
            >
              <span className="truncate">{publication.publicUrl}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </a>
          ) : (
            <p className="mt-1 text-sm text-muted">
              {t("projects.publish.noLiveUrl", {
                defaultValue: "No live URL yet",
              })}
            </p>
          )}
        </div>
        {!isPublished ? (
          <Button
            onClick={() =>
              needsDeployment ? setWizardOpen(true) : void handleRepublish()
            }
            disabled={operationBusy}
            className="min-h-11 shrink-0"
          >
            {operationBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden />
            )}
            {needsDeployment
              ? t("projects.publish.finishCta", {
                  defaultValue: "Finish publishing",
                })
              : t("projects.publish.republishCta", {
                  defaultValue: "Republish",
                })}
          </Button>
        ) : null}
      </section>

      {operationError ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>
            {t("projects.publish.operationFailed", {
              defaultValue: "Publication update failed",
            })}
          </AlertTitle>
          <AlertDescription>{operationError}</AlertDescription>
        </Alert>
      ) : null}

      <PublishingAccountContext appId={app.id} />

      <AppDetailsTabs
        app={app}
        showApiKey={showApiKey}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        settingsProps={{
          projectPublication: true,
          onApiKeyRegenerated: (apiKey) => {
            setShowApiKey(apiKey);
            setActiveTab("overview");
          },
          onUnpublish: handleUnpublish,
          onDelete: handleDelete,
        }}
      />
    </div>
  );
}

/** Public panel mounted by the per-project Publish tab. */
export function ProjectPublishPanel({
  project,
  onProjectChanged,
}: ProjectPublishPanelProps): React.JSX.Element {
  const connected = useAppSelectorShallow((state) => state.elizaCloudConnected);
  if (!connected) return <CloudConnectionGate />;
  return (
    <CloudSettingsSectionShell>
      <ProjectPublishPanelBody
        project={project}
        onProjectChanged={onProjectChanged}
      />
    </CloudSettingsSectionShell>
  );
}
