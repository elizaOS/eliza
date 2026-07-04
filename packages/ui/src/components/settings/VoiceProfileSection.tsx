/**
 * VoiceProfileSection — voice-profile manager. Lists known profiles (owner
 * pinned at top) with rename / set-relationship / delete affordances. Data
 * comes from `VoiceProfilesClient`; an empty list renders the empty state.
 */

import { Crown, Download, Mic, Pencil, Trash2 } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import type {
  VoiceProfile,
  VoiceProfilesClient,
} from "../../api/client-voice-profiles";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { SettingsSelectTrigger } from "../ui/settings-controls";

export interface VoiceProfileSectionProps {
  /** Adapter supplied by the parent that holds the `ElizaClient`. */
  profilesClient: VoiceProfilesClient;
  /** Pre-loaded profiles (skips initial fetch — useful for tests). */
  initialProfiles?: VoiceProfile[];
  className?: string;
}

type ProfileAction =
  | { type: "rename"; id: string; displayName: string }
  | { type: "delete"; id: string }
  | { type: "set-relationship"; id: string; relationshipLabel: string | null };

function compareProfiles(a: VoiceProfile, b: VoiceProfile): number {
  if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
  const ar = relationshipRank(a.cohort);
  const br = relationshipRank(b.cohort);
  if (ar !== br) return ar - br;
  return (b.lastHeardAtMs ?? 0) - (a.lastHeardAtMs ?? 0);
}

function relationshipRank(cohort: VoiceProfile["cohort"]): number {
  switch (cohort) {
    case "owner":
      return 0;
    case "family":
      return 1;
    case "guest":
      return 2;
    default:
      return 3;
  }
}

/**
 * Sentinel for the "(no label)" relationship choice. The profile stores a
 * relationship as `string | null`; Radix Select forbids an empty-string item
 * value, so this sentinel stands in for "no relationship" and maps back to
 * `null` at the value/onChange boundary.
 */
const NO_RELATIONSHIP_VALUE = "__none__";

const COMMON_RELATIONSHIPS = [
  "wife",
  "husband",
  "partner",
  "child",
  "mother",
  "father",
  "sibling",
  "friend",
  "colleague",
  "roommate",
];

const VoiceProfileRow = React.memo(function VoiceProfileRow({
  profile,
  isEditingThis,
  renameValue,
  setRenameValue,
  setRenameId,
  dispatch,
}: {
  profile: VoiceProfile;
  isEditingThis: boolean;
  renameValue: string;
  setRenameValue: (value: string) => void;
  setRenameId: (id: string | null) => void;
  dispatch: (action: ProfileAction) => void;
}) {
  const { t } = useTranslation();
  const { ref: nameRef, agentProps: nameAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `voice-profile-name-${profile.id}`,
      role: "button",
      label: t("voiceprofile.renameAria", {
        defaultValue: "Rename voice profile",
      }),
      group: "voice-profiles-list",
      onActivate: () => {
        setRenameId(profile.id);
        setRenameValue(profile.displayName);
      },
    });
  const { ref: renameInputRef, agentProps: renameInputAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: `voice-profile-rename-input-${profile.id}`,
      role: "text-input",
      label: t("voiceprofile.renameAria", {
        defaultValue: "Rename voice profile",
      }),
      group: "voice-profiles-list",
      getValue: () => renameValue,
      onFill: setRenameValue,
    });
  const { ref: relationshipRef, agentProps: relationshipAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `voice-profile-relationship-${profile.id}`,
      role: "select",
      label: t("voiceprofile.setRelationship", {
        defaultValue: "Set relationship",
      }),
      group: "voice-profiles-list",
      getValue: () => profile.relationshipLabel ?? NO_RELATIONSHIP_VALUE,
      onFill: (value) =>
        dispatch({
          type: "set-relationship",
          id: profile.id,
          relationshipLabel:
            value && value !== NO_RELATIONSHIP_VALUE ? value : null,
        }),
      options: [NO_RELATIONSHIP_VALUE, ...COMMON_RELATIONSHIPS],
    });
  const { ref: renameBtnRef, agentProps: renameBtnAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `voice-profile-rename-${profile.id}`,
      role: "button",
      label: t("voiceprofile.renameAria", {
        defaultValue: "Rename voice profile",
      }),
      group: "voice-profiles-list",
      onActivate: () => {
        setRenameId(profile.id);
        setRenameValue(profile.displayName);
      },
    });
  const { ref: deleteRef, agentProps: deleteAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `voice-profile-delete-${profile.id}`,
      role: "button",
      label: t("voiceprofile.deleteAria", {
        defaultValue: "Delete voice profile",
      }),
      group: "voice-profiles-list",
      onActivate: () => dispatch({ type: "delete", id: profile.id }),
    });

  return (
    <li
      data-testid={`voice-profile-row-${profile.id}`}
      data-is-owner={profile.isOwner ? "true" : "false"}
      data-cohort={profile.cohort}
      className="flex items-center gap-3 py-2.5"
    >
      {profile.isOwner ? (
        <Crown
          className="h-4 w-4 shrink-0 text-accent"
          aria-label={t("voiceprofile.owner", { defaultValue: "Owner" })}
          data-testid={`voice-profile-crown-${profile.id}`}
        />
      ) : (
        <span className="inline-block h-4 w-4 shrink-0" aria-hidden="true" />
      )}

      <div className="min-w-0 flex-1">
        {isEditingThis ? (
          <Input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => {
              setRenameId(null);
              if (renameValue.trim() && renameValue !== profile.displayName) {
                dispatch({
                  type: "rename",
                  id: profile.id,
                  displayName: renameValue.trim(),
                });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                setRenameId(null);
                setRenameValue("");
              }
            }}
            autoFocus
            className="h-11 rounded-md border-border bg-surface text-sm"
            data-testid={`voice-profile-rename-input-${profile.id}`}
            aria-label={t("voiceprofile.renameAria", {
              defaultValue: "Rename voice profile",
            })}
            {...renameInputAgentProps}
          />
        ) : (
          <Button
            ref={nameRef}
            onClick={() => {
              setRenameId(profile.id);
              setRenameValue(profile.displayName);
            }}
            variant="ghost"
            size="sm"
            className="h-auto justify-start px-0 py-0 text-left text-sm font-medium hover:bg-transparent hover:underline"
            data-testid={`voice-profile-name-${profile.id}`}
            {...nameAgentProps}
          >
            {profile.displayName}
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span data-testid={`voice-profile-samples-${profile.id}`}>
            {profile.embeddingCount === 1
              ? t("voiceprofile.sampleOne", {
                  count: profile.embeddingCount,
                  defaultValue: "{{count}} sample",
                })
              : t("voiceprofile.sampleOther", {
                  count: profile.embeddingCount,
                  defaultValue: "{{count}} samples",
                })}
          </span>
          {profile.relationshipLabel ? (
            <span
              className="rounded-sm bg-bg/60 px-1 py-0.5"
              data-testid={`voice-profile-relationship-${profile.id}`}
            >
              {profile.relationshipLabel}
            </span>
          ) : null}
          <span>{profile.cohort}</span>
        </div>
      </div>

      {!profile.isOwner ? (
        <div className="flex items-center gap-1">
          <Select
            value={profile.relationshipLabel ?? NO_RELATIONSHIP_VALUE}
            onValueChange={(value) =>
              dispatch({
                type: "set-relationship",
                id: profile.id,
                relationshipLabel:
                  value === NO_RELATIONSHIP_VALUE ? null : value,
              })
            }
          >
            <SettingsSelectTrigger
              ref={relationshipRef}
              variant="soft"
              data-testid={`voice-profile-relationship-select-${profile.id}`}
              aria-label={t("voiceprofile.setRelationship", {
                defaultValue: "Set relationship",
              })}
              {...relationshipAgentProps}
            >
              <SelectValue />
            </SettingsSelectTrigger>
            <SelectContent>
              <SelectItem value={NO_RELATIONSHIP_VALUE}>
                {t("voiceprofile.noLabel", { defaultValue: "(no label)" })}
              </SelectItem>
              {COMMON_RELATIONSHIPS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            ref={renameBtnRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              setRenameId(profile.id);
              setRenameValue(profile.displayName);
            }}
            data-testid={`voice-profile-rename-${profile.id}`}
            aria-label={t("voiceprofile.renameAria", {
              defaultValue: "Rename voice profile",
            })}
            {...renameBtnAgentProps}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            ref={deleteRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => dispatch({ type: "delete", id: profile.id })}
            data-testid={`voice-profile-delete-${profile.id}`}
            aria-label={t("voiceprofile.deleteAria", {
              defaultValue: "Delete voice profile",
            })}
            {...deleteAgentProps}
          >
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
        </div>
      ) : null}
    </li>
  );
});

export function VoiceProfileSection({
  profilesClient,
  initialProfiles,
  className,
}: VoiceProfileSectionProps): React.ReactElement {
  const { t } = useTranslation();
  const [profiles, setProfiles] = React.useState<VoiceProfile[]>(
    initialProfiles ?? [],
  );
  const [loading, setLoading] = React.useState<boolean>(
    initialProfiles === undefined,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [renameId, setRenameId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState<string>("");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await profilesClient.list();
      setProfiles(list);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("voiceprofile.error.load", {
              defaultValue: "Failed to load voice profiles.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [profilesClient, t]);

  React.useEffect(() => {
    if (initialProfiles !== undefined) {
      setProfiles(initialProfiles);
      return;
    }
    void refresh();
  }, [initialProfiles, refresh]);

  const { sorted, ownerCount, otherCount } = React.useMemo(() => {
    const next = [...profiles].sort(compareProfiles);
    const owners = next.filter((p) => p.isOwner).length;
    return {
      sorted: next,
      ownerCount: owners,
      otherCount: next.length - owners,
    };
  }, [profiles]);

  const dispatch = React.useCallback(
    async (action: ProfileAction) => {
      try {
        switch (action.type) {
          case "rename":
            await profilesClient.patch(action.id, {
              displayName: action.displayName,
            });
            setProfiles((prev) =>
              prev.map((p) =>
                p.id === action.id
                  ? { ...p, displayName: action.displayName }
                  : p,
              ),
            );
            break;
          case "set-relationship":
            await profilesClient.patch(action.id, {
              relationshipLabel: action.relationshipLabel,
            });
            setProfiles((prev) =>
              prev.map((p) =>
                p.id === action.id
                  ? { ...p, relationshipLabel: action.relationshipLabel }
                  : p,
              ),
            );
            break;
          case "delete": {
            const target = profiles.find((p) => p.id === action.id);
            if (target?.isOwner) {
              setError(
                t("voiceprofile.error.ownerDelete", {
                  defaultValue: "The owner profile can't be deleted.",
                }),
              );
              return;
            }
            await profilesClient.delete(action.id);
            setProfiles((prev) => prev.filter((p) => p.id !== action.id));
            break;
          }
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("voiceprofile.error.update", {
                defaultValue: "Failed to update voice profile.",
              }),
        );
      }
    },
    [profiles, profilesClient, t],
  );

  const dispatchAction = React.useCallback(
    (action: ProfileAction) => void dispatch(action),
    [dispatch],
  );

  const onExport = React.useCallback(async () => {
    try {
      const { downloadUrl } = await profilesClient.exportAll();
      if (downloadUrl && typeof window !== "undefined") {
        window.open(downloadUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("voiceprofile.error.export", {
              defaultValue: "Failed to export profiles.",
            }),
      );
    }
  }, [profilesClient, t]);

  const onDeleteAll = React.useCallback(async () => {
    try {
      await profilesClient.deleteAll();
      setProfiles((prev) => prev.filter((p) => p.isOwner));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("voiceprofile.error.delete", {
              defaultValue: "Failed to delete profiles.",
            }),
      );
    }
  }, [profilesClient, t]);

  const { ref: exportRef, agentProps: exportAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "voice-profile-export",
      role: "button",
      label: t("voiceprofile.exportAria", {
        defaultValue: "Export voice profile metadata",
      }),
      group: "voice-profiles",
      onActivate: () => void onExport(),
    });
  const { ref: resetRef, agentProps: resetAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "voice-profile-delete-all",
      role: "button",
      label: t("voiceprofile.resetAria", {
        defaultValue: "Delete all non-owner voice profiles",
      }),
      group: "voice-profiles",
      onActivate: () => void onDeleteAll(),
    });

  return (
    <div
      data-testid="voice-profile-section"
      className={cn("flex flex-col", className)}
    >
      <header className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs text-muted" data-testid="voice-profile-count">
          {ownerCount > 0
            ? t("voiceprofile.ownerCount", {
                count: ownerCount,
                defaultValue: "{{count}} owner · ",
              })
            : ""}
          {otherCount === 1
            ? t("voiceprofile.otherCountOne", {
                count: otherCount,
                defaultValue: "{{count}} other",
              })
            : t("voiceprofile.otherCount", {
                count: otherCount,
                defaultValue: "{{count}} others",
              })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            ref={exportRef}
            variant="ghost"
            size="sm"
            onClick={() => void onExport()}
            data-testid="voice-profile-export"
            aria-label={t("voiceprofile.exportAria", {
              defaultValue: "Export voice profile metadata",
            })}
            {...exportAgentProps}
          >
            <Download className="mr-1 h-3.5 w-3.5" />{" "}
            {t("voiceprofile.export", { defaultValue: "Export" })}
          </Button>
          <Button
            ref={resetRef}
            variant="ghost"
            size="sm"
            onClick={() => void onDeleteAll()}
            data-testid="voice-profile-delete-all"
            aria-label={t("voiceprofile.resetAria", {
              defaultValue: "Delete all non-owner voice profiles",
            })}
            {...resetAgentProps}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />{" "}
            {t("voiceprofile.reset", { defaultValue: "Reset" })}
          </Button>
        </div>
      </header>

      {error ? (
        <div
          className="py-2 text-xs text-warn"
          data-testid="voice-profile-error"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div
          className="py-6 text-center text-xs text-muted"
          data-testid="voice-profile-loading"
        >
          {t("voiceprofile.loading", { defaultValue: "Loading profiles…" })}
        </div>
      ) : sorted.length === 0 ? (
        <div
          className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted"
          data-testid="voice-profile-empty"
        >
          <Mic className="h-5 w-5 text-muted" aria-hidden />
          {t("voiceprofile.empty", {
            defaultValue: "No voice profiles yet.",
          })}
        </div>
      ) : (
        <ul className="flex flex-col" data-testid="voice-profile-list">
          {sorted.map((profile) => {
            const isEditingThis = renameId === profile.id;
            return (
              <VoiceProfileRow
                key={profile.id}
                profile={profile}
                isEditingThis={isEditingThis}
                // Only the editing row needs the live draft; passing "" to the
                // rest keeps their props stable so memo skips them per keystroke.
                renameValue={isEditingThis ? renameValue : ""}
                setRenameValue={setRenameValue}
                setRenameId={setRenameId}
                dispatch={dispatchAction}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default VoiceProfileSection;
