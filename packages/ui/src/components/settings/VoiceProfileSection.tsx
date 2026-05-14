/**
 * VoiceProfileSection — voice-profile manager settings panel (R10 §5).
 *
 * Lists known voice profiles (OWNER pinned at top) with rename / set
 * relationship / merge / split / delete affordances. Server data comes
 * from `VoiceProfilesClient` (R10 §5.3 adapter) — when I2 hasn't landed
 * the endpoints yet the adapter returns `[]` and we render the empty
 * state instead of crashing.
 */

// biome-ignore lint/correctness/noUnusedImports: Required for JSX transform.
import * as React from "react";
import { Crown, Download, Mic, Pencil, Trash2, Users } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  VoiceProfilesClient,
  type VoiceProfile,
} from "../../api/client-voice-profiles";
import { Button } from "../ui/button";

export interface VoiceProfileSectionProps {
  /**
   * Adapter (R10 §5.3). Must be supplied by the parent that holds the
   * `ElizaClient`.  In tests the caller can pass a fake adapter.
   */
  profilesClient: VoiceProfilesClient;
  /** Pre-loaded profiles (skips initial fetch — useful for tests). */
  initialProfiles?: VoiceProfile[];
  /** Render the panel inside a settings card chrome (default true). */
  framed?: boolean;
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

export function VoiceProfileSection({
  profilesClient,
  initialProfiles,
  framed = true,
  className,
}: VoiceProfileSectionProps): React.ReactElement {
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
          : "Failed to load voice profiles.",
      );
    } finally {
      setLoading(false);
    }
  }, [profilesClient]);

  React.useEffect(() => {
    if (initialProfiles !== undefined) {
      setProfiles(initialProfiles);
      return;
    }
    void refresh();
  }, [initialProfiles, refresh]);

  const sorted = React.useMemo(
    () => [...profiles].sort(compareProfiles),
    [profiles],
  );

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
              setError("Owner profile cannot be deleted from this panel.");
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
            : "Failed to update voice profile.",
        );
      }
    },
    [profiles, profilesClient],
  );

  const onExport = React.useCallback(async () => {
    try {
      const { downloadUrl } = await profilesClient.exportAll();
      if (downloadUrl && typeof window !== "undefined") {
        window.open(downloadUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to export profiles.",
      );
    }
  }, [profilesClient]);

  const onDeleteAll = React.useCallback(async () => {
    try {
      await profilesClient.deleteAll();
      setProfiles((prev) => prev.filter((p) => p.isOwner));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete profiles.",
      );
    }
  }, [profilesClient]);

  const ownerCount = sorted.filter((p) => p.isOwner).length;
  const otherCount = sorted.length - ownerCount;

  return (
    <div
      data-testid="voice-profile-section"
      className={cn(
        framed && "rounded-lg border border-border/40 bg-card/40",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted" aria-hidden />
          <h3 className="text-sm font-semibold">Voice profiles</h3>
          <span
            className="rounded-full bg-bg/60 px-1.5 py-0.5 text-[10px] text-muted"
            data-testid="voice-profile-count"
          >
            {ownerCount > 0 ? `${ownerCount} owner · ` : ""}
            {otherCount} {otherCount === 1 ? "other" : "others"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onExport()}
            data-testid="voice-profile-export"
            aria-label="Export voice profile metadata"
          >
            <Download className="mr-1 h-3.5 w-3.5" /> Export
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onDeleteAll()}
            data-testid="voice-profile-delete-all"
            aria-label="Delete all non-owner voice profiles"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Reset
          </Button>
        </div>
      </header>

      {error ? (
        <div
          className="mx-4 mb-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
          data-testid="voice-profile-error"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div
          className="px-4 py-6 text-center text-xs text-muted"
          data-testid="voice-profile-loading"
        >
          Loading profiles…
        </div>
      ) : sorted.length === 0 ? (
        <div
          className="px-4 py-6 text-center text-xs text-muted"
          data-testid="voice-profile-empty"
        >
          <Mic className="mx-auto mb-2 h-5 w-5 text-muted" aria-hidden />
          No voice profiles yet. They'll appear here automatically when the
          agent hears a distinct voice (or you can add one in onboarding).
        </div>
      ) : (
        <ul className="divide-y divide-border/30" data-testid="voice-profile-list">
          {sorted.map((profile) => {
            const isEditingThis = renameId === profile.id;
            return (
              <li
                key={profile.id}
                data-testid={`voice-profile-row-${profile.id}`}
                data-is-owner={profile.isOwner ? "true" : "false"}
                data-cohort={profile.cohort}
                className="flex items-center gap-3 px-4 py-3"
              >
                {profile.isOwner ? (
                  <Crown
                    className="h-4 w-4 shrink-0 text-accent"
                    aria-label="Owner"
                    data-testid={`voice-profile-crown-${profile.id}`}
                  />
                ) : (
                  <span
                    className="inline-block h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                )}

                <div className="min-w-0 flex-1">
                  {isEditingThis ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
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
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        }
                        if (e.key === "Escape") {
                          setRenameId(null);
                          setRenameValue("");
                        }
                      }}
                      // biome-ignore lint/a11y/noAutofocus: this is an inline rename input the user just clicked into; focus must follow.
                      autoFocus
                      className="w-full rounded border border-border/40 bg-bg/50 px-2 py-0.5 text-sm"
                      data-testid={`voice-profile-rename-input-${profile.id}`}
                      aria-label="Rename voice profile"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRenameId(profile.id);
                        setRenameValue(profile.displayName);
                      }}
                      className="text-left text-sm font-medium hover:underline"
                      data-testid={`voice-profile-name-${profile.id}`}
                    >
                      {profile.displayName}
                    </button>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span data-testid={`voice-profile-samples-${profile.id}`}>
                      {profile.embeddingCount} sample
                      {profile.embeddingCount === 1 ? "" : "s"}
                    </span>
                    {profile.relationshipLabel ? (
                      <span
                        className="rounded bg-bg/60 px-1 py-0.5"
                        data-testid={`voice-profile-relationship-${profile.id}`}
                      >
                        {profile.relationshipLabel}
                      </span>
                    ) : null}
                    <span className="opacity-60">{profile.cohort}</span>
                  </div>
                </div>

                {!profile.isOwner ? (
                  <div className="flex items-center gap-1">
                    <select
                      value={profile.relationshipLabel ?? ""}
                      onChange={(e) =>
                        void dispatch({
                          type: "set-relationship",
                          id: profile.id,
                          relationshipLabel: e.target.value || null,
                        })
                      }
                      className="rounded border border-border/40 bg-bg/50 px-1 py-0.5 text-xs"
                      data-testid={`voice-profile-relationship-select-${profile.id}`}
                      aria-label="Set relationship"
                    >
                      <option value="">(no label)</option>
                      {COMMON_RELATIONSHIPS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setRenameId(profile.id);
                        setRenameValue(profile.displayName);
                      }}
                      data-testid={`voice-profile-rename-${profile.id}`}
                      aria-label="Rename voice profile"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        void dispatch({ type: "delete", id: profile.id })
                      }
                      data-testid={`voice-profile-delete-${profile.id}`}
                      aria-label="Delete voice profile"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-danger" />
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default VoiceProfileSection;
