package ai.elizaos.app;

/** An owner may activate only after every prior native cancellation has durably settled. */
final class ClockOwnerRetirement {
    interface Completion { void retireAll() throws Exception; }
    private volatile boolean blocked;
    boolean isBlocked() { return blocked; }
    void failed() { blocked = true; }
    void retry(Completion completion) throws Exception {
        try { completion.retireAll(); blocked = false; }
        catch (Exception error) { blocked = true; throw error; }
    }
}
