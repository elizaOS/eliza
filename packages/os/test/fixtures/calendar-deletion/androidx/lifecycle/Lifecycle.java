// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package androidx.lifecycle;

public final class Lifecycle {
  public enum State { DESTROYED, INITIALIZED, CREATED, STARTED, RESUMED; public boolean isAtLeast(State state) { return compareTo(state) >= 0; } }
  public State state = State.RESUMED;
  public State getCurrentState() { return state; }
}
