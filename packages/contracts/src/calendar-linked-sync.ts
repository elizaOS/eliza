/** Shared two-way calendar reconciliation. Host ports own storage and provider I/O.
 * Opaque phone/browser revisions and numeric SQL revisions use the same state machine. */
export type LinkedCalendarState =
  | "clean"
  | "dirty"
  | "conflicted"
  | "quarantined"
  | "paused"
  | "local_only";

export type LinkedCalendarOperation = "create" | "update" | "delete";

export interface LinkedCalendarEventRecord<
  Revision extends string | number = number,
> {
  id: string;
  agentId: string;
  localEventId: string;
  connectorAccountId: string;
  providerCalendarId: string;
  providerEventId: string | null;
  providerEtag: string | null;
  localRevision: Revision;
  lastCommonSemanticHash: string | null;
  state: LinkedCalendarState;
  pendingOperation: LinkedCalendarOperation | null;
  idempotencyKey: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedCalendarSemanticEvent {
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  timeZone: string | null;
  isAllDay: boolean;
  attendees: ReadonlyArray<{ email: string; optional?: boolean }>;
  recurrence?: readonly string[];
  deleted?: boolean;
}

export interface LinkedCalendarLocalSnapshot<
  Revision extends string | number = number,
> {
  eventId: string;
  revision: Revision;
  event: LinkedCalendarSemanticEvent;
}

export interface LinkedCalendarProviderSnapshot {
  eventId: string;
  etag: string | null;
  event: LinkedCalendarSemanticEvent;
}

export interface LinkedCalendarProviderPort<
  Revision extends string | number = number,
> {
  get(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<LinkedCalendarProviderSnapshot | null>;
  create(
    record: LinkedCalendarEventRecord<Revision>,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot>;
  update(
    record: LinkedCalendarEventRecord<Revision>,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot>;
  delete(record: LinkedCalendarEventRecord<Revision>): Promise<void>;
}

export interface LinkedCalendarLocalPort<
  Revision extends string | number = number,
> {
  get(eventId: string): Promise<LinkedCalendarLocalSnapshot<Revision> | null>;
  applyProviderEvent(
    eventId: string,
    event: LinkedCalendarSemanticEvent,
    expectedRevision: Revision,
  ): Promise<LinkedCalendarLocalSnapshot<Revision>>;
  delete(eventId: string, expectedRevision: Revision): Promise<void>;
  /** Recreates a deleted local event under its original id, at a revision after `previousRevision`. */
  restore?(
    eventId: string,
    event: LinkedCalendarSemanticEvent,
    previousRevision: Revision,
  ): Promise<LinkedCalendarLocalSnapshot<Revision>>;
}

export interface LinkedCalendarCheckpointStore<
  Revision extends string | number = number,
> {
  save(
    record: LinkedCalendarEventRecord<Revision>,
    patch: Partial<
      Omit<
        LinkedCalendarEventRecord<Revision>,
        "id" | "agentId" | "localEventId" | "createdAt"
      >
    >,
    now?: Date,
  ): Promise<LinkedCalendarEventRecord<Revision>>;
}

function googleMutationFailure(error: unknown): {
  outcome: "not_accepted" | "precondition_failed";
  code: string;
  message: string;
} | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    outcome?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    candidate.outcome !== "not_accepted" &&
    candidate.outcome !== "precondition_failed"
  ) {
    return null;
  }
  return {
    outcome: candidate.outcome,
    code:
      typeof candidate.code === "string"
        ? candidate.code
        : "GOOGLE_CALENDAR_MUTATION_REJECTED",
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : "Google Calendar rejected the mutation.",
  };
}

function semanticText(
  event: LinkedCalendarSemanticEvent,
  normalizeTimes: boolean,
): string {
  const normalized = {
    title: event.title.trim(),
    description: event.description.trim(),
    location: event.location.trim(),
    startAt:
      normalizeTimes && !event.isAllDay
        ? new Date(event.startAt).toISOString()
        : event.startAt,
    endAt:
      normalizeTimes && !event.isAllDay
        ? new Date(event.endAt).toISOString()
        : event.endAt,
    timeZone: event.isAllDay ? null : event.timeZone,
    // Retain timed-event checkpoints; all-day semantics need a distinct hash.
    ...(event.isAllDay ? { isAllDay: true } : {}),
    attendees: [...event.attendees]
      .map((attendee) => ({
        email: attendee.email.trim().toLowerCase(),
        optional: attendee.optional === true,
      }))
      .sort((left, right) =>
        left.email < right.email ? -1 : left.email > right.email ? 1 : 0,
      ),
    deleted: event.deleted === true,
    ...(event.recurrence?.length
      ? { recurrence: [...event.recurrence].map((line) => line.trim()).sort() }
      : {}),
  };
  return JSON.stringify(normalized);
}

export function linkedCalendarSemanticText(
  event: LinkedCalendarSemanticEvent,
): string {
  return semanticText(event, true);
}

async function digestText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function linkedCalendarSemanticDigest(
  event: LinkedCalendarSemanticEvent,
): Promise<string> {
  return digestText(linkedCalendarSemanticText(event));
}

// Read old checkpoints until the next successful reconciliation saves the canonical digest.
async function matchesCheckpoint(
  hash: string | null,
  event: LinkedCalendarSemanticEvent,
  current: string,
): Promise<boolean> {
  return (
    hash === current ||
    (hash !== null && hash === (await digestText(semanticText(event, false))))
  );
}

export type LinkedCalendarReconcileOutcome =
  | "clean"
  | "dirty"
  | "pushed"
  | "pulled"
  | "conflicted"
  | "quarantined"
  | "paused";

export type LinkedCalendarRecoveryOutcome =
  | "landed"
  | "not_landed"
  | "unresolved";

export class LinkedCalendarReconciler<
  Revision extends string | number = number,
> {
  constructor(
    private readonly repository: LinkedCalendarCheckpointStore<Revision>,
    private readonly local: LinkedCalendarLocalPort<Revision>,
    private readonly provider: LinkedCalendarProviderPort<Revision>,
    private readonly onProviderMutation?: () => void,
  ) {}

  async reconcile(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<LinkedCalendarReconcileOutcome> {
    if (record.state === "paused" || record.state === "local_only")
      return "paused";
    if (record.state === "conflicted") return this.settleConflict(record);
    if (record.state === "quarantined") return "quarantined";

    const local = await this.local.get(record.localEventId);
    if (!local) {
      if (record.pendingOperation === "delete") {
        const provider = await this.provider.get(record);
        try {
          if (provider) {
            this.onProviderMutation?.();
            await this.provider.delete(record);
          }
        } catch (error) {
          const mutationFailure = googleMutationFailure(error);
          if (mutationFailure?.outcome === "not_accepted") {
            await this.repository.save(record, {
              state: "dirty",
              pendingOperation: "delete",
              lastErrorCode: mutationFailure.code,
              lastErrorMessage: mutationFailure.message,
            });
            return "dirty";
          }
          if (mutationFailure?.outcome === "precondition_failed") {
            await this.repository.save(record, {
              state: "conflicted",
              pendingOperation: null,
              lastErrorCode: mutationFailure.code,
              lastErrorMessage: mutationFailure.message,
            });
            return "conflicted";
          }
          return this.quarantine(
            record,
            "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEtag: null,
          lastErrorCode: "LINKED_CALENDAR_LOCAL_EVENT_DELETED",
          lastErrorMessage:
            "The Eliza event was deleted and the linked Google event was removed.",
        });
        return "pushed";
      }
      return this.quarantine(
        record,
        "LINKED_LOCAL_EVENT_MISSING",
        "The linked Eliza event no longer exists.",
      );
    }
    const provider = await this.provider.get(record);
    const localHash = await linkedCalendarSemanticDigest(local.event);
    const providerHash = provider
      ? await linkedCalendarSemanticDigest(provider.event)
      : null;
    const localChanged = !(await matchesCheckpoint(
      record.lastCommonSemanticHash,
      local.event,
      localHash,
    ));
    const providerChanged =
      provider !== null &&
      providerHash !== null &&
      !(await matchesCheckpoint(
        record.lastCommonSemanticHash,
        provider.event,
        providerHash,
      ));

    if (
      provider &&
      localChanged &&
      providerChanged &&
      localHash !== providerHash
    ) {
      await this.repository.save(record, {
        state: "conflicted",
        pendingOperation: null,
        lastErrorCode: "LINKED_CALENDAR_CONCURRENT_EDIT",
        lastErrorMessage:
          "Eliza and Google changed since their last common version.",
      });
      return "conflicted";
    }

    if (
      provider &&
      providerChanged &&
      !localChanged &&
      localHash !== providerHash
    ) {
      if (provider.event.deleted) {
        try {
          await this.local.delete(local.eventId, local.revision);
        } catch (error) {
          return this.quarantine(
            record,
            "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEventId: provider.eventId,
          providerEtag: provider.etag,
          lastCommonSemanticHash: await linkedCalendarSemanticDigest(
            provider.event,
          ),
          lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
          lastErrorMessage:
            "Google deleted the linked event; the Eliza event was removed and the retained link was paused.",
        });
        return "pulled";
      }
      let applied: LinkedCalendarLocalSnapshot<Revision>;
      try {
        applied = await this.local.applyProviderEvent(
          local.eventId,
          provider.event,
          local.revision,
        );
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        localRevision: applied.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: providerHash,
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "pulled";
    }

    if (!provider && record.providerEventId && !localChanged) {
      try {
        await this.local.delete(local.eventId, local.revision);
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        state: "paused",
        pendingOperation: null,
        providerEtag: null,
        lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
        lastErrorMessage:
          "Google deleted the linked event; the Eliza event was removed and the retained link was paused.",
      });
      return "pulled";
    }

    if (!provider || (localChanged && localHash !== providerHash)) {
      return this.push(record, local, provider);
    }

    if (
      record.state !== "clean" ||
      record.lastCommonSemanticHash !== localHash ||
      record.localRevision !== local.revision ||
      record.providerEtag !== provider.etag
    ) {
      await this.repository.save(record, {
        localRevision: local.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: localHash,
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    }
    return "clean";
  }

  /**
   * Checkpoints a provider-confirmed outcome without replaying a mutation.
   * The caller retains the dispatch barrier unless this returns "landed" or
   * "not_landed". An absent create or unchanged ETag proves nothing until the
   * caller's settle window has passed; only then is the row returned to dirty
   * so an owner-initiated resume can re-derive it under the same idempotency
   * key or ETag precondition.
   */
  async recoverDispatch(
    record: LinkedCalendarEventRecord<Revision>,
    release?: { dispatchedAt: Date | null; settleMs: number; now?: Date },
  ): Promise<LinkedCalendarRecoveryOutcome> {
    const local = await this.local.get(record.localEventId);
    const provider = await this.provider.get(record);
    const settled =
      release?.dispatchedAt != null &&
      (release.now ?? new Date()).getTime() - release.dispatchedAt.getTime() >=
        release.settleMs;
    const unchangedTarget =
      provider !== null &&
      !provider.event.deleted &&
      record.providerEventId !== null &&
      provider.eventId === record.providerEventId &&
      record.providerEtag !== null &&
      provider.etag === record.providerEtag;
    if (record.pendingOperation === "delete") {
      if (
        record.providerEventId &&
        !provider &&
        (!local || local.event.deleted)
      ) {
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEtag: null,
          lastErrorCode: "LINKED_CALENDAR_DELETE_RECOVERED",
          lastErrorMessage: "Google confirmed the pending event deletion.",
        });
        return "landed";
      }
      return settled && unchangedTarget
        ? this.releaseNotLanded(record)
        : "unresolved";
    }
    if (
      local &&
      provider &&
      !local.event.deleted &&
      !provider.event.deleted &&
      (await linkedCalendarSemanticDigest(local.event)) ===
        (await linkedCalendarSemanticDigest(provider.event)) &&
      !(
        record.pendingOperation === "update" &&
        (!record.providerEtag ||
          !provider.etag ||
          record.providerEtag === provider.etag)
      )
    ) {
      await this.repository.save(record, {
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        localRevision: local.revision,
        lastCommonSemanticHash: await linkedCalendarSemanticDigest(
          provider.event,
        ),
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "landed";
    }
    if (!settled) return "unresolved";
    if (
      record.pendingOperation === "create" &&
      !record.providerEventId &&
      !provider
    )
      return this.releaseNotLanded(record);
    if (record.pendingOperation === "update" && unchangedTarget)
      return this.releaseNotLanded(record);
    return "unresolved";
  }

  private async releaseNotLanded(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<"not_landed"> {
    await this.repository.save(record, {
      state: "dirty",
      lastErrorCode: "LINKED_CALENDAR_DISPATCH_NOT_LANDED",
      lastErrorMessage:
        "Google shows the pending change never landed. It will be sent again when sync resumes.",
    });
    return "not_landed";
  }

  async resolveConflict(
    record: LinkedCalendarEventRecord<Revision>,
    strategy: "keep_eliza" | "keep_google",
  ): Promise<LinkedCalendarReconcileOutcome> {
    if (record.state !== "conflicted") return this.reconcile(record);
    const local = await this.local.get(record.localEventId);
    const current = await this.provider.get(record);
    const provider = current && !current.event.deleted ? current : null;
    if (!local) {
      if (!provider) {
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEtag: null,
          lastErrorCode: "LINKED_CALENDAR_BOTH_EVENTS_DELETED",
          lastErrorMessage: "Both the Eliza and Google events were deleted.",
        });
        return "paused";
      }
      if (strategy === "keep_eliza") {
        // Eliza's deletion wins: delete the Google copy at the version read now.
        const dirty = await this.repository.save(record, {
          state: "dirty",
          pendingOperation: "delete",
          providerEventId: provider.eventId,
          providerEtag: provider.etag,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
        return this.reconcile(dirty);
      }
      if (!this.local.restore)
        return this.quarantine(
          record,
          "LINKED_LOCAL_EVENT_MISSING",
          "The linked Eliza event no longer exists.",
        );
      let restored: LinkedCalendarLocalSnapshot<Revision>;
      try {
        restored = await this.local.restore(
          record.localEventId,
          provider.event,
          record.localRevision,
        );
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_RESTORE_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        localRevision: restored.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: await linkedCalendarSemanticDigest(
          provider.event,
        ),
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "pulled";
    }
    if (!provider) {
      if (strategy === "keep_google") {
        // Google's deletion wins: remove the Eliza event and pause the link.
        try {
          await this.local.delete(local.eventId, local.revision);
        } catch (error) {
          return this.quarantine(
            record,
            "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEtag: null,
          lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
          lastErrorMessage:
            "Google deleted the linked event; the Eliza event was removed and the retained link was paused.",
        });
        return "pulled";
      }
      // Google will not reuse a deleted event's id, so recreate under a new key.
      const dirty = await this.repository.save(record, {
        state: "dirty",
        pendingOperation: "create",
        providerEventId: null,
        providerEtag: null,
        lastCommonSemanticHash: null,
        localRevision: local.revision,
        idempotencyKey: `linked-calendar:recreate:${await digestText(
          `${record.idempotencyKey}\n${record.updatedAt}`,
        )}`,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return this.reconcile(dirty);
    }
    if (strategy === "keep_google") {
      let applied: LinkedCalendarLocalSnapshot<Revision>;
      try {
        applied = await this.local.applyProviderEvent(
          local.eventId,
          provider.event,
          local.revision,
        );
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        localRevision: applied.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: await linkedCalendarSemanticDigest(
          provider.event,
        ),
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "pulled";
    }
    if (!provider.etag)
      return this.quarantine(
        record,
        "LINKED_PROVIDER_REVISION_MISSING",
        "The provider did not supply an exact revision. No write was attempted.",
      );
    const dirty = await this.repository.save(record, {
      state: "dirty",
      pendingOperation: "update",
      providerEventId: provider.eventId,
      providerEtag: provider.etag,
      localRevision: local.revision,
      lastCommonSemanticHash: await linkedCalendarSemanticDigest(
        provider.event,
      ),
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    return this.reconcile(dirty);
  }

  /**
   * A conflicted row stays conflicted until the owner picks a side, unless a
   * fresh read shows both sides already hold the same version.
   */
  private async settleConflict(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<LinkedCalendarReconcileOutcome> {
    const local = await this.local.get(record.localEventId);
    if (!local || local.event.deleted) return "conflicted";
    const provider = await this.provider.get(record);
    if (!provider || provider.event.deleted) return "conflicted";
    const localHash = await linkedCalendarSemanticDigest(local.event);
    if (localHash !== (await linkedCalendarSemanticDigest(provider.event)))
      return "conflicted";
    await this.repository.save(record, {
      localRevision: local.revision,
      providerEventId: provider.eventId,
      providerEtag: provider.etag,
      lastCommonSemanticHash: localHash,
      state: "clean",
      pendingOperation: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    return "clean";
  }

  private async push(
    record: LinkedCalendarEventRecord<Revision>,
    local: LinkedCalendarLocalSnapshot<Revision>,
    provider: LinkedCalendarProviderSnapshot | null,
  ): Promise<LinkedCalendarReconcileOutcome> {
    const operation: LinkedCalendarOperation = local.event.deleted
      ? "delete"
      : provider
        ? "update"
        : "create";
    let pending = record;
    if (record.pendingOperation !== operation || record.state !== "dirty") {
      pending = await this.repository.save(record, {
        state: "dirty",
        pendingOperation: operation,
        localRevision: local.revision,
      });
    }
    try {
      if (operation === "delete") {
        if (provider) {
          this.onProviderMutation?.();
          await this.provider.delete(pending);
        }
        await this.repository.save(pending, {
          providerEventId: provider?.eventId ?? pending.providerEventId,
          providerEtag: null,
          lastCommonSemanticHash: await linkedCalendarSemanticDigest(
            local.event,
          ),
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
      } else {
        this.onProviderMutation?.();
        const written =
          operation === "create"
            ? await this.provider.create(pending, local.event)
            : await this.provider.update(pending, local.event);
        await this.repository.save(pending, {
          providerEventId: written.eventId,
          providerEtag: written.etag,
          localRevision: local.revision,
          lastCommonSemanticHash: await linkedCalendarSemanticDigest(
            written.event,
          ),
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
      }
      return "pushed";
    } catch (error) {
      const mutationFailure = googleMutationFailure(error);
      if (mutationFailure) {
        const state: LinkedCalendarState =
          mutationFailure.outcome === "precondition_failed"
            ? "conflicted"
            : "dirty";
        await this.repository.save(pending, {
          state,
          pendingOperation: state === "dirty" ? operation : null,
          lastErrorCode: mutationFailure.code,
          lastErrorMessage: mutationFailure.message,
        });
        return state === "conflicted" ? "conflicted" : "dirty";
      }
      return this.quarantine(
        pending,
        "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async quarantine(
    record: LinkedCalendarEventRecord<Revision>,
    code: string,
    message: string,
  ): Promise<"quarantined"> {
    await this.repository.save(record, {
      state: "quarantined",
      lastErrorCode: code,
      lastErrorMessage: message,
    });
    return "quarantined";
  }
}
