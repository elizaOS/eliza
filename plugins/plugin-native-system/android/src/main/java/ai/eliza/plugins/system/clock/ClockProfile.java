package ai.eliza.plugins.system.clock;

/**
 * What a host's native Clock surface advertises to its agent. Pure; no Android types.
 *
 * <p>{@link #HANDOFF_ONLY} is the shared policy: Android's Clock app owns alarms, the host only
 * opens it with a reviewed request, and a launched Activity is never a receipt that an alarm
 * changed. {@link #OWNED_ALARMS} is a host that keeps its own alarm store (the Eliza app's
 * {@code ElizaAlarms}) and can report applied changes for alarms it owns.
 *
 * <p>Moving a host from {@link #OWNED_ALARMS} to {@link #HANDOFF_ONLY} must also choose what happens
 * to alarms it already saved ({@link SavedAlarms}); until that product decision is recorded a host
 * keeps {@link SavedAlarms#KEEP_OWNED}.
 */
public enum ClockProfile {
    HANDOFF_ONLY("clock.handoff.v1,clock.handoff.v2", "clock_handoff"),
    OWNED_ALARMS("clock.alarms.v1", "clock_alarm");

    /** What happens to a host's saved alarms when it changes profile. */
    public enum SavedAlarms {
        /** Current behaviour: the host keeps scheduling and ringing the alarms it saved. */
        KEEP_OWNED,
        /** Saved alarms stay listed but no longer ring or change; the owner recreates them in Clock. */
        READ_ONLY,
        /** Each saved alarm is offered to the owner as a reviewed Clock handoff, then retired. */
        HAND_OFF_TO_CLOCK
    }

    /** The comma-separated capability list sent in the device capability header. */
    public final String capabilities;
    /** The device-action operation type the host accepts from the agent. */
    public final String operationType;

    ClockProfile(String capabilities, String operationType) {
        this.capabilities = capabilities;
        this.operationType = operationType;
    }

    /** Whether a launch outcome may be reported as an applied alarm change. Never for a handoff. */
    public boolean reportsAppliedChanges() {
        return this == OWNED_ALARMS;
    }

    /** The saved-alarm path a host takes when leaving {@code from} for {@code this}. */
    public SavedAlarms savedAlarmsFrom(ClockProfile from, SavedAlarms decided) {
        if (from == this || from == HANDOFF_ONLY) return SavedAlarms.KEEP_OWNED;
        return decided == null ? SavedAlarms.KEEP_OWNED : decided;
    }
}
