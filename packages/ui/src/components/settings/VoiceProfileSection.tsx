/**
 * VoiceProfileSection — voice-profile manager. Lists known profiles (owner
 * pinned at top) with rename, relationship, merge, split, bind, unbind, export,
 * and delete affordances. Data comes from `VoiceProfilesClient`; an empty list
 * renders the empty state.
 */

import {
  Crown,
  Download,
  GitMerge,
  Link2,
  Link2Off,
  Mic,
  Pencil,
  Scissors,
  Settings2,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import type {
  VoiceProfile,
  VoiceProfilesClient,
} from "../../api/client-voice-profiles";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { isSafeNavigationUrl } from "../../utils/navigation-url";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { SettingsSelectTrigger } from "../ui/settings-controls";
import { SettingsInputRow, SettingsSelectRow } from "./settings-agent-rows";

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
  | { type: "set-relationship"; id: string; relationshipLabel: string | null }
  | { type: "merge"; id: string; intoId: string }
  | { type: "split"; id: string; utteranceIds: string[] }
  | { type: "bind"; id: string; entityId: string; label?: string }
  | { type: "unbind"; id: string };

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

function sampleLabel(
  sample: VoiceProfile["samples"][number],
  index: number,
): string {
  const durationSeconds = Math.max(0, sample.durationMs / 1000).toFixed(1);
  const recorded = Date.parse(sample.recordedAt);
  const recordedLabel = Number.isFinite(recorded)
    ? new Date(recorded).toISOString().slice(0, 10)
    : null;
  return recordedLabel
    ? `Sample ${index + 1} · ${durationSeconds}s · ${recordedLabel}`
    : `Sample ${index + 1} · ${durationSeconds}s`;
}

function VoiceProfileLifecycleEditor({
  profile,
  profiles,
  pending,
  dispatch,
}: {
  profile: VoiceProfile;
  profiles: VoiceProfile[];
  pending: boolean;
  dispatch: (action: ProfileAction) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [mergeIntoId, setMergeIntoId] = React.useState("");
  const [entityId, setEntityId] = React.useState("");
  const [entityLabel, setEntityLabel] = React.useState("");
  const [selectedSamples, setSelectedSamples] = React.useState<Set<string>>(
    () => new Set(),
  );
  const mergeTargets = profiles.filter(
    (candidate) => candidate.id !== profile.id,
  );

  const toggleSample = React.useCallback(
    (sampleId: string, checked: boolean) => {
      setSelectedSamples((current) => {
        const next = new Set(current);
        if (checked) next.add(sampleId);
        else next.delete(sampleId);
        return next;
      });
    },
    [],
  );

  const canSplit =
    selectedSamples.size > 0 && selectedSamples.size < profile.samples.length;
  const canBind = entityId.trim().length > 0;

  return (
    <div
      className="mt-2 grid gap-3 rounded-md border border-border bg-bg/35 p-3"
      data-testid={`voice-profile-lifecycle-${profile.id}`}
    >
      <div className="text-xs font-medium text-fg">
        {t("voiceprofile.lifecycle.title", {
          defaultValue: "Profile lifecycle",
        })}
      </div>

      {!profile.isOwner && mergeTargets.length > 0 ? (
        <SettingsSelectRow
          agentId={`voice-profile-merge-${profile.id}`}
          group="voice-profiles"
          label={t("voiceprofile.merge.target", {
            defaultValue: "Merge into",
          })}
          value={mergeIntoId}
          onValueChange={setMergeIntoId}
          placeholder={t("voiceprofile.merge.choose", {
            defaultValue: "Choose destination profile",
          })}
          testId={`voice-profile-merge-target-${profile.id}`}
          trailingStackUntilSm
          options={mergeTargets.map((candidate) => ({
            value: candidate.id,
            label: candidate.displayName,
          }))}
          trailing={
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={!mergeIntoId || pending}
              onClick={() =>
                void dispatch({
                  type: "merge",
                  id: profile.id,
                  intoId: mergeIntoId,
                })
              }
              data-testid={`voice-profile-merge-${profile.id}`}
            >
              <GitMerge className="mr-1.5 h-4 w-4" />
              {t("voiceprofile.merge.action", {
                defaultValue: "Merge profile",
              })}
            </Button>
          }
        />
      ) : null}

      {profile.samples.length >= 2 ? (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">
            {t("voiceprofile.split.samples", {
              defaultValue: "Move samples into a new profile",
            })}
          </legend>
          <div className="grid gap-1.5">
            {profile.samples.map((sample, index) => {
              const checkboxId = `voice-profile-split-${profile.id}-${sample.id}`;
              return (
                <div
                  key={sample.id}
                  className="flex min-h-11 items-center gap-2"
                >
                  <Checkbox
                    id={checkboxId}
                    checked={selectedSamples.has(sample.id)}
                    disabled={pending}
                    onCheckedChange={(checked) =>
                      toggleSample(sample.id, checked === true)
                    }
                    data-testid={checkboxId}
                  />
                  <Label
                    htmlFor={checkboxId}
                    className="font-normal text-muted"
                  >
                    {sampleLabel(sample, index)}
                  </Label>
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 justify-self-start"
            disabled={!canSplit || pending}
            onClick={() =>
              void dispatch({
                type: "split",
                id: profile.id,
                utteranceIds: [...selectedSamples],
              })
            }
            data-testid={`voice-profile-split-${profile.id}`}
          >
            <Scissors className="mr-1.5 h-4 w-4" />
            {t("voiceprofile.split.action", { defaultValue: "Split profile" })}
          </Button>
          {selectedSamples.size === profile.samples.length ? (
            <p className="text-xs text-warn">
              {t("voiceprofile.split.keepOne", {
                defaultValue:
                  "Leave at least one sample in the original profile.",
              })}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {!profile.entityId ? (
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <SettingsInputRow
              agentId={`voice-profile-entity-${profile.id}`}
              group="voice-profiles"
              label={t("voiceprofile.bind.entity", {
                defaultValue: "Entity ID",
              })}
              value={entityId}
              onValueChange={setEntityId}
              testId={`voice-profile-bind-entity-${profile.id}`}
              inputClassName="h-11"
            />
            <SettingsInputRow
              agentId={`voice-profile-entity-label-${profile.id}`}
              group="voice-profiles"
              label={t("voiceprofile.bind.label", {
                defaultValue: "Binding label (optional)",
              })}
              value={entityLabel}
              onValueChange={setEntityLabel}
              testId={`voice-profile-bind-label-${profile.id}`}
              inputClassName="h-11"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 justify-self-start"
            disabled={!canBind || pending}
            onClick={() => {
              const label = entityLabel.trim();
              void dispatch({
                type: "bind",
                id: profile.id,
                entityId: entityId.trim(),
                ...(label ? { label } : {}),
              });
            }}
            data-testid={`voice-profile-bind-${profile.id}`}
          >
            <Link2 className="mr-1.5 h-4 w-4" />
            {t("voiceprofile.bind.action", { defaultValue: "Bind entity" })}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-all text-xs text-muted">
            {t("voiceprofile.bind.boundTo", {
              entityId: profile.entityId,
              defaultValue: "Bound to {{entityId}}",
            })}
          </span>
          {!profile.isOwner ? (
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={pending}
              onClick={() => void dispatch({ type: "unbind", id: profile.id })}
              data-testid={`voice-profile-unbind-${profile.id}`}
            >
              <Link2Off className="mr-1.5 h-4 w-4" />
              {t("voiceprofile.unbind.action", { defaultValue: "Unbind" })}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

const VoiceProfileRow = React.memo(function VoiceProfileRow({
  profile,
  isEditingThis,
  renameValue,
  setRenameValue,
  setRenameId,
  profiles,
  isManagingThis,
  setManageId,
  pending,
  dispatch,
}: {
  profile: VoiceProfile;
  isEditingThis: boolean;
  renameValue: string;
  setRenameValue: (value: string) => void;
  setRenameId: (id: string | null) => void;
  profiles: VoiceProfile[];
  isManagingThis: boolean;
  setManageId: (id: string | null) => void;
  pending: boolean;
  dispatch: (action: ProfileAction) => Promise<boolean>;
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
        void dispatch({
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
      onActivate: () => void dispatch({ type: "delete", id: profile.id }),
    });
  const { ref: manageRef, agentProps: manageAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `voice-profile-manage-${profile.id}`,
      role: "button",
      label: t("voiceprofile.manage", {
        defaultValue: "Manage voice profile lifecycle",
      }),
      group: "voice-profiles-list",
      onActivate: () => setManageId(isManagingThis ? null : profile.id),
    });

  return (
    <li
      data-testid={`voice-profile-row-${profile.id}`}
      data-is-owner={profile.isOwner ? "true" : "false"}
      data-cohort={profile.cohort}
      className="py-2.5"
    >
      <div className="flex flex-wrap items-center gap-3">
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
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={() => {
                setRenameId(null);
                if (renameValue.trim() && renameValue !== profile.displayName) {
                  void dispatch({
                    type: "rename",
                    id: profile.id,
                    displayName: renameValue.trim(),
                  });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
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
              className="min-h-11 justify-start px-0 py-0 text-left text-sm font-medium hover:bg-transparent hover:underline"
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

        <div className="ml-7 flex w-full flex-wrap items-center justify-end gap-1 sm:ml-0 sm:w-auto sm:flex-nowrap">
          {!profile.isOwner ? (
            <>
              <div className="w-full sm:w-36">
                <Select
                  value={profile.relationshipLabel ?? NO_RELATIONSHIP_VALUE}
                  onValueChange={(value) =>
                    void dispatch({
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
                    className="min-h-11"
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
                      {t("voiceprofile.noLabel", {
                        defaultValue: "(no label)",
                      })}
                    </SelectItem>
                    {COMMON_RELATIONSHIPS.map((relationship) => (
                      <SelectItem key={relationship} value={relationship}>
                        {relationship}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                ref={renameBtnRef}
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11"
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
                className="h-11 w-11"
                onClick={() =>
                  void dispatch({ type: "delete", id: profile.id })
                }
                data-testid={`voice-profile-delete-${profile.id}`}
                aria-label={t("voiceprofile.deleteAria", {
                  defaultValue: "Delete voice profile",
                })}
                {...deleteAgentProps}
              >
                <Trash2 className="h-3.5 w-3.5 text-danger" />
              </Button>
            </>
          ) : null}
          <Button
            ref={manageRef}
            type="button"
            variant={isManagingThis ? "secondary" : "ghost"}
            size="icon"
            className="h-11 w-11"
            onClick={() => setManageId(isManagingThis ? null : profile.id)}
            data-testid={`voice-profile-manage-${profile.id}`}
            aria-expanded={isManagingThis}
            aria-label={t("voiceprofile.manage", {
              defaultValue: "Manage voice profile lifecycle",
            })}
            {...manageAgentProps}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {isManagingThis ? (
        <VoiceProfileLifecycleEditor
          profile={profile}
          profiles={profiles}
          pending={pending}
          dispatch={dispatch}
        />
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
  const [notice, setNotice] = React.useState<string | null>(null);
  const [renameId, setRenameId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState<string>("");
  const [manageId, setManageId] = React.useState<string | null>(null);
  const [pendingProfileId, setPendingProfileId] = React.useState<string | null>(
    null,
  );

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
      setError(null);
      setNotice(null);
      setPendingProfileId(action.id);
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
            setNotice(
              t("voiceprofile.notice.renamed", {
                defaultValue: "Voice profile renamed.",
              }),
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
            setNotice(
              t("voiceprofile.notice.relationship", {
                defaultValue: "Relationship updated.",
              }),
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
              return false;
            }
            await profilesClient.delete(action.id);
            setProfiles((prev) => prev.filter((p) => p.id !== action.id));
            setManageId(null);
            setNotice(
              t("voiceprofile.notice.deleted", {
                defaultValue: "Voice profile deleted.",
              }),
            );
            break;
          }
          case "merge": {
            const merged = await profilesClient.merge(action.id, {
              intoId: action.intoId,
            });
            setProfiles((prev) => [
              ...prev.filter(
                (profile) =>
                  profile.id !== action.id && profile.id !== action.intoId,
              ),
              merged,
            ]);
            setManageId(null);
            setNotice(
              t("voiceprofile.notice.merged", {
                defaultValue: "Voice profiles merged.",
              }),
            );
            break;
          }
          case "split": {
            const result = await profilesClient.split(action.id, {
              utteranceIds: action.utteranceIds,
            });
            setProfiles((prev) => [
              ...prev.filter((profile) => profile.id !== action.id),
              result.original,
              result.split,
            ]);
            setManageId(null);
            setNotice(
              t("voiceprofile.notice.split", {
                defaultValue: "Voice profile split.",
              }),
            );
            break;
          }
          case "bind": {
            const bound = await profilesClient.bind(action.id, {
              entityId: action.entityId,
              ...(action.label ? { label: action.label } : {}),
            });
            setProfiles((prev) =>
              prev.map((profile) =>
                profile.id === action.id ? bound : profile,
              ),
            );
            setNotice(
              t("voiceprofile.notice.bound", {
                defaultValue: "Voice profile bound to the entity.",
              }),
            );
            break;
          }
          case "unbind": {
            const unbound = await profilesClient.unbind(action.id);
            setProfiles((prev) =>
              prev.map((profile) =>
                profile.id === action.id ? unbound : profile,
              ),
            );
            setNotice(
              t("voiceprofile.notice.unbound", {
                defaultValue: "Voice profile unbound.",
              }),
            );
            break;
          }
        }
        return true;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("voiceprofile.error.update", {
                defaultValue: "Failed to update voice profile.",
              }),
        );
        return false;
      } finally {
        setPendingProfileId(null);
      }
    },
    [profiles, profilesClient, t],
  );

  const onExport = React.useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      const { downloadUrl } = await profilesClient.exportAll();
      // The downloadUrl is a wire value — a non-http(s) target fails closed
      // and surfaces the export error state instead of opening.
      if (downloadUrl) {
        if (!isSafeNavigationUrl(downloadUrl)) {
          setError(
            t("voiceprofile.error.invalidExportUrl", {
              defaultValue:
                "The export link returned by the server is not a valid URL.",
            }),
          );
          return;
        }
        if (typeof window !== "undefined") {
          window.open(downloadUrl, "_blank", "noopener,noreferrer");
        }
      }
      setNotice(
        t("voiceprofile.notice.exported", {
          defaultValue: "Voice profile export opened.",
        }),
      );
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
    setError(null);
    setNotice(null);
    try {
      await profilesClient.deleteAll();
      setProfiles((prev) => prev.filter((p) => p.isOwner));
      setManageId(null);
      setNotice(
        t("voiceprofile.notice.reset", {
          defaultValue: "Non-owner voice profiles deleted.",
        }),
      );
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
      className={cn("flex flex-col pb-24", className)}
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
            className="min-h-11"
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
            className="min-h-11"
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

      {notice ? (
        <div
          className="py-2 text-xs text-success"
          role="status"
          data-testid="voice-profile-notice"
        >
          {notice}
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
                profiles={sorted}
                isManagingThis={manageId === profile.id}
                setManageId={setManageId}
                pending={pendingProfileId === profile.id}
                dispatch={dispatch}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default VoiceProfileSection;
