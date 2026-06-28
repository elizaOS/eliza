import {
  type LifeOpsReminderService,
  type RemindersDeps,
  RemindersDomain,
} from "./domains/reminders-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export type { LifeOpsReminderService } from "./domains/reminders-service.js";
export { REMINDER_DISPATCH_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

/** @internal */
export function withReminders<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsReminderService> {
  class LifeOpsRemindersServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext, and the
    // composed runtime service supplies the cross-domain dependencies below.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly remindersDomain = new RemindersDomain(this, {
      runDueWorkflows: (...args) =>
        (this as unknown as RemindersDeps).runDueWorkflows(...args),
      runDueEventWorkflows: (...args) =>
        (this as unknown as RemindersDeps).runDueEventWorkflows(...args),
      snoozeOccurrence: (...args) =>
        (this as unknown as RemindersDeps).snoozeOccurrence(...args),
      checkinSource: this as unknown as RemindersDeps["checkinSource"],
    });

    readRecentReminderConversation(
      ...args: Parameters<RemindersDomain["readRecentReminderConversation"]>
    ): ReturnType<RemindersDomain["readRecentReminderConversation"]> {
      return this.remindersDomain.readRecentReminderConversation(...args);
    }

    classifyReminderOwnerResponseSemantically(
      ...args: Parameters<
        RemindersDomain["classifyReminderOwnerResponseSemantically"]
      >
    ): ReturnType<
      RemindersDomain["classifyReminderOwnerResponseSemantically"]
    > {
      return this.remindersDomain.classifyReminderOwnerResponseSemantically(
        ...args,
      );
    }

    reviewOwnerResponseAfterReminderAttempt(
      ...args: Parameters<
        RemindersDomain["reviewOwnerResponseAfterReminderAttempt"]
      >
    ): ReturnType<RemindersDomain["reviewOwnerResponseAfterReminderAttempt"]> {
      return this.remindersDomain.reviewOwnerResponseAfterReminderAttempt(
        ...args,
      );
    }

    renderReminderBody(
      ...args: Parameters<RemindersDomain["renderReminderBody"]>
    ): ReturnType<RemindersDomain["renderReminderBody"]> {
      return this.remindersDomain.renderReminderBody(...args);
    }

    renderWorkflowRunBody(
      ...args: Parameters<RemindersDomain["renderWorkflowRunBody"]>
    ): ReturnType<RemindersDomain["renderWorkflowRunBody"]> {
      return this.remindersDomain.renderWorkflowRunBody(...args);
    }

    emitWorkflowRunNudge(
      ...args: Parameters<RemindersDomain["emitWorkflowRunNudge"]>
    ): ReturnType<RemindersDomain["emitWorkflowRunNudge"]> {
      return this.remindersDomain.emitWorkflowRunNudge(...args);
    }

    withNativeAppleReminderId(
      ...args: Parameters<RemindersDomain["withNativeAppleReminderId"]>
    ): ReturnType<RemindersDomain["withNativeAppleReminderId"]> {
      return this.remindersDomain.withNativeAppleReminderId(...args);
    }

    syncNativeAppleReminderForDefinition(
      ...args: Parameters<
        RemindersDomain["syncNativeAppleReminderForDefinition"]
      >
    ): ReturnType<RemindersDomain["syncNativeAppleReminderForDefinition"]> {
      return this.remindersDomain.syncNativeAppleReminderForDefinition(...args);
    }

    getDefinitionRecord(
      ...args: Parameters<RemindersDomain["getDefinitionRecord"]>
    ): ReturnType<RemindersDomain["getDefinitionRecord"]> {
      return this.remindersDomain.getDefinitionRecord(...args);
    }

    getGoalRecord(
      ...args: Parameters<RemindersDomain["getGoalRecord"]>
    ): ReturnType<RemindersDomain["getGoalRecord"]> {
      return this.remindersDomain.getGoalRecord(...args);
    }

    ensureGoalExists(
      ...args: Parameters<RemindersDomain["ensureGoalExists"]>
    ): ReturnType<RemindersDomain["ensureGoalExists"]> {
      return this.remindersDomain.ensureGoalExists(...args);
    }

    syncGoalLink(
      ...args: Parameters<RemindersDomain["syncGoalLink"]>
    ): ReturnType<RemindersDomain["syncGoalLink"]> {
      return this.remindersDomain.syncGoalLink(...args);
    }

    syncReminderPlan(
      ...args: Parameters<RemindersDomain["syncReminderPlan"]>
    ): ReturnType<RemindersDomain["syncReminderPlan"]> {
      return this.remindersDomain.syncReminderPlan(...args);
    }

    serializeScheduleObservationForSync(
      ...args: Parameters<
        RemindersDomain["serializeScheduleObservationForSync"]
      >
    ): ReturnType<RemindersDomain["serializeScheduleObservationForSync"]> {
      return this.remindersDomain.serializeScheduleObservationForSync(...args);
    }

    refreshLocalMergedScheduleState(
      ...args: Parameters<RemindersDomain["refreshLocalMergedScheduleState"]>
    ): ReturnType<RemindersDomain["refreshLocalMergedScheduleState"]> {
      return this.remindersDomain.refreshLocalMergedScheduleState(...args);
    }

    ingestScheduleObservations(
      ...args: Parameters<RemindersDomain["ingestScheduleObservations"]>
    ): ReturnType<RemindersDomain["ingestScheduleObservations"]> {
      return this.remindersDomain.ingestScheduleObservations(...args);
    }

    fetchCloudMergedScheduleState(
      ...args: Parameters<RemindersDomain["fetchCloudMergedScheduleState"]>
    ): ReturnType<RemindersDomain["fetchCloudMergedScheduleState"]> {
      return this.remindersDomain.fetchCloudMergedScheduleState(...args);
    }

    readEffectiveScheduleState(
      ...args: Parameters<RemindersDomain["readEffectiveScheduleState"]>
    ): ReturnType<RemindersDomain["readEffectiveScheduleState"]> {
      return this.remindersDomain.readEffectiveScheduleState(...args);
    }

    refreshEffectiveScheduleState(
      ...args: Parameters<RemindersDomain["refreshEffectiveScheduleState"]>
    ): ReturnType<RemindersDomain["refreshEffectiveScheduleState"]> {
      return this.remindersDomain.refreshEffectiveScheduleState(...args);
    }

    getScheduleMergedState(
      ...args: Parameters<RemindersDomain["getScheduleMergedState"]>
    ): ReturnType<RemindersDomain["getScheduleMergedState"]> {
      return this.remindersDomain.getScheduleMergedState(...args);
    }

    resolveAdaptiveWindowPolicy(
      ...args: Parameters<RemindersDomain["resolveAdaptiveWindowPolicy"]>
    ): ReturnType<RemindersDomain["resolveAdaptiveWindowPolicy"]> {
      return this.remindersDomain.resolveAdaptiveWindowPolicy(...args);
    }

    refreshDefinitionOccurrences(
      ...args: Parameters<RemindersDomain["refreshDefinitionOccurrences"]>
    ): ReturnType<RemindersDomain["refreshDefinitionOccurrences"]> {
      return this.remindersDomain.refreshDefinitionOccurrences(...args);
    }

    getFreshOccurrence(
      ...args: Parameters<RemindersDomain["getFreshOccurrence"]>
    ): ReturnType<RemindersDomain["getFreshOccurrence"]> {
      return this.remindersDomain.getFreshOccurrence(...args);
    }

    resolvePrimaryChannelPolicy(
      ...args: Parameters<RemindersDomain["resolvePrimaryChannelPolicy"]>
    ): ReturnType<RemindersDomain["resolvePrimaryChannelPolicy"]> {
      return this.remindersDomain.resolvePrimaryChannelPolicy(...args);
    }

    resolveRuntimeReminderTarget(
      ...args: Parameters<RemindersDomain["resolveRuntimeReminderTarget"]>
    ): ReturnType<RemindersDomain["resolveRuntimeReminderTarget"]> {
      return this.remindersDomain.resolveRuntimeReminderTarget(...args);
    }

    readLifeOpsAttentionContext(
      ...args: Parameters<RemindersDomain["readLifeOpsAttentionContext"]>
    ): ReturnType<RemindersDomain["readLifeOpsAttentionContext"]> {
      return this.remindersDomain.readLifeOpsAttentionContext(...args);
    }

    readReminderActivityProfileSnapshot(
      ...args: Parameters<
        RemindersDomain["readReminderActivityProfileSnapshot"]
      >
    ): ReturnType<RemindersDomain["readReminderActivityProfileSnapshot"]> {
      return this.remindersDomain.readReminderActivityProfileSnapshot(...args);
    }

    scanReadReceipts(
      ...args: Parameters<RemindersDomain["scanReadReceipts"]>
    ): ReturnType<RemindersDomain["scanReadReceipts"]> {
      return this.remindersDomain.scanReadReceipts(...args);
    }

    buildReminderPlanSchedule(
      ...args: Parameters<RemindersDomain["buildReminderPlanSchedule"]>
    ): ReturnType<RemindersDomain["buildReminderPlanSchedule"]> {
      return this.remindersDomain.buildReminderPlanSchedule(...args);
    }

    resolveOwnerContactRouteCandidates(
      ...args: Parameters<RemindersDomain["resolveOwnerContactRouteCandidates"]>
    ): ReturnType<RemindersDomain["resolveOwnerContactRouteCandidates"]> {
      return this.remindersDomain.resolveOwnerContactRouteCandidates(...args);
    }

    resolveReminderEscalationRouteCandidates(
      ...args: Parameters<
        RemindersDomain["resolveReminderEscalationRouteCandidates"]
      >
    ): ReturnType<RemindersDomain["resolveReminderEscalationRouteCandidates"]> {
      return this.remindersDomain.resolveReminderEscalationRouteCandidates(
        ...args,
      );
    }

    buildOwnerContactRouteEventMetadata(
      ...args: Parameters<
        RemindersDomain["buildOwnerContactRouteEventMetadata"]
      >
    ): ReturnType<RemindersDomain["buildOwnerContactRouteEventMetadata"]> {
      return this.remindersDomain.buildOwnerContactRouteEventMetadata(...args);
    }

    resolveReminderEscalationChannels(
      ...args: Parameters<RemindersDomain["resolveReminderEscalationChannels"]>
    ): ReturnType<RemindersDomain["resolveReminderEscalationChannels"]> {
      return this.remindersDomain.resolveReminderEscalationChannels(...args);
    }

    markReminderEscalationStarted(
      ...args: Parameters<RemindersDomain["markReminderEscalationStarted"]>
    ): ReturnType<RemindersDomain["markReminderEscalationStarted"]> {
      return this.remindersDomain.markReminderEscalationStarted(...args);
    }

    resolveReminderEscalation(
      ...args: Parameters<RemindersDomain["resolveReminderEscalation"]>
    ): ReturnType<RemindersDomain["resolveReminderEscalation"]> {
      return this.remindersDomain.resolveReminderEscalation(...args);
    }

    resolveReminderReviewFromOwnerResponse(
      ...args: Parameters<
        RemindersDomain["resolveReminderReviewFromOwnerResponse"]
      >
    ): ReturnType<RemindersDomain["resolveReminderReviewFromOwnerResponse"]> {
      return this.remindersDomain.resolveReminderReviewFromOwnerResponse(
        ...args,
      );
    }

    markReminderReviewResolvedFromState(
      ...args: Parameters<
        RemindersDomain["markReminderReviewResolvedFromState"]
      >
    ): ReturnType<RemindersDomain["markReminderReviewResolvedFromState"]> {
      return this.remindersDomain.markReminderReviewResolvedFromState(...args);
    }

    markReminderReviewEscalated(
      ...args: Parameters<RemindersDomain["markReminderReviewEscalated"]>
    ): ReturnType<RemindersDomain["markReminderReviewEscalated"]> {
      return this.remindersDomain.markReminderReviewEscalated(...args);
    }

    markReminderReviewClarificationRequested(
      ...args: Parameters<
        RemindersDomain["markReminderReviewClarificationRequested"]
      >
    ): ReturnType<RemindersDomain["markReminderReviewClarificationRequested"]> {
      return this.remindersDomain.markReminderReviewClarificationRequested(
        ...args,
      );
    }

    markReminderReviewObservedResponse(
      ...args: Parameters<RemindersDomain["markReminderReviewObservedResponse"]>
    ): ReturnType<RemindersDomain["markReminderReviewObservedResponse"]> {
      return this.remindersDomain.markReminderReviewObservedResponse(...args);
    }

    processDueReminderReviewJobs(
      ...args: Parameters<RemindersDomain["processDueReminderReviewJobs"]>
    ): ReturnType<RemindersDomain["processDueReminderReviewJobs"]> {
      return this.remindersDomain.processDueReminderReviewJobs(...args);
    }

    dispatchDueReminderEscalation(
      ...args: Parameters<RemindersDomain["dispatchDueReminderEscalation"]>
    ): ReturnType<RemindersDomain["dispatchDueReminderEscalation"]> {
      return this.remindersDomain.dispatchDueReminderEscalation(...args);
    }

    awardWebsiteAccessGrant(
      ...args: Parameters<RemindersDomain["awardWebsiteAccessGrant"]>
    ): ReturnType<RemindersDomain["awardWebsiteAccessGrant"]> {
      return this.remindersDomain.awardWebsiteAccessGrant(...args);
    }

    syncWebsiteAccessState(
      ...args: Parameters<RemindersDomain["syncWebsiteAccessState"]>
    ): ReturnType<RemindersDomain["syncWebsiteAccessState"]> {
      return this.remindersDomain.syncWebsiteAccessState(...args);
    }

    dispatchReminderAttempt(
      ...args: Parameters<RemindersDomain["dispatchReminderAttempt"]>
    ): ReturnType<RemindersDomain["dispatchReminderAttempt"]> {
      return this.remindersDomain.dispatchReminderAttempt(...args);
    }

    resolveGlobalReminderPreferencePolicy(
      ...args: Parameters<
        RemindersDomain["resolveGlobalReminderPreferencePolicy"]
      >
    ): ReturnType<RemindersDomain["resolveGlobalReminderPreferencePolicy"]> {
      return this.remindersDomain.resolveGlobalReminderPreferencePolicy(
        ...args,
      );
    }

    buildReminderPreferenceResponse(
      ...args: Parameters<RemindersDomain["buildReminderPreferenceResponse"]>
    ): ReturnType<RemindersDomain["buildReminderPreferenceResponse"]> {
      return this.remindersDomain.buildReminderPreferenceResponse(...args);
    }

    resolveEffectiveReminderPlan(
      ...args: Parameters<RemindersDomain["resolveEffectiveReminderPlan"]>
    ): ReturnType<RemindersDomain["resolveEffectiveReminderPlan"]> {
      return this.remindersDomain.resolveEffectiveReminderPlan(...args);
    }

    getReminderPreference(
      ...args: Parameters<RemindersDomain["getReminderPreference"]>
    ): ReturnType<RemindersDomain["getReminderPreference"]> {
      return this.remindersDomain.getReminderPreference(...args);
    }

    setReminderPreference(
      ...args: Parameters<RemindersDomain["setReminderPreference"]>
    ): ReturnType<RemindersDomain["setReminderPreference"]> {
      return this.remindersDomain.setReminderPreference(...args);
    }

    captureActivitySignal(
      ...args: Parameters<RemindersDomain["captureActivitySignal"]>
    ): ReturnType<RemindersDomain["captureActivitySignal"]> {
      return this.remindersDomain.captureActivitySignal(...args);
    }

    captureManualOverride(
      ...args: Parameters<RemindersDomain["captureManualOverride"]>
    ): ReturnType<RemindersDomain["captureManualOverride"]> {
      return this.remindersDomain.captureManualOverride(...args);
    }

    listActivitySignals(
      ...args: Parameters<RemindersDomain["listActivitySignals"]>
    ): ReturnType<RemindersDomain["listActivitySignals"]> {
      return this.remindersDomain.listActivitySignals(...args);
    }

    upsertChannelPolicy(
      ...args: Parameters<RemindersDomain["upsertChannelPolicy"]>
    ): ReturnType<RemindersDomain["upsertChannelPolicy"]> {
      return this.remindersDomain.upsertChannelPolicy(...args);
    }

    capturePhoneConsent(
      ...args: Parameters<RemindersDomain["capturePhoneConsent"]>
    ): ReturnType<RemindersDomain["capturePhoneConsent"]> {
      return this.remindersDomain.capturePhoneConsent(...args);
    }

    processDueReminderDeliveries(
      ...args: Parameters<RemindersDomain["processDueReminderDeliveries"]>
    ): ReturnType<RemindersDomain["processDueReminderDeliveries"]> {
      return this.remindersDomain.processDueReminderDeliveries(...args);
    }

    processReminders(
      ...args: Parameters<RemindersDomain["processReminders"]>
    ): ReturnType<RemindersDomain["processReminders"]> {
      return this.remindersDomain.processReminders(...args);
    }

    processScheduledWork(
      ...args: Parameters<RemindersDomain["processScheduledWork"]>
    ): ReturnType<RemindersDomain["processScheduledWork"]> {
      return this.remindersDomain.processScheduledWork(...args);
    }

    relockWebsiteAccessGroup(
      ...args: Parameters<RemindersDomain["relockWebsiteAccessGroup"]>
    ): ReturnType<RemindersDomain["relockWebsiteAccessGroup"]> {
      return this.remindersDomain.relockWebsiteAccessGroup(...args);
    }

    resolveWebsiteAccessCallback(
      ...args: Parameters<RemindersDomain["resolveWebsiteAccessCallback"]>
    ): ReturnType<RemindersDomain["resolveWebsiteAccessCallback"]> {
      return this.remindersDomain.resolveWebsiteAccessCallback(...args);
    }

    inspectReminder(
      ...args: Parameters<RemindersDomain["inspectReminder"]>
    ): ReturnType<RemindersDomain["inspectReminder"]> {
      return this.remindersDomain.inspectReminder(...args);
    }

    acknowledgeReminder(
      ...args: Parameters<RemindersDomain["acknowledgeReminder"]>
    ): ReturnType<RemindersDomain["acknowledgeReminder"]> {
      return this.remindersDomain.acknowledgeReminder(...args);
    }
  }

  return LifeOpsRemindersServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsReminderService
  >;
}
