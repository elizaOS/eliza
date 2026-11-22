package ai.eliza.plugins.agent.runtime;

import java.util.Locale;

/** A start that failed for a known reason, so a host can say why instead of only that it failed. */
public final class RuntimeStartFailure extends NativeProcessSupervisor.LifecycleException {
  public enum Cause { PAYLOAD, STORAGE, CONFIG, CREDENTIAL, AGENT, GATEWAY, CRASHED, RUNTIME }
  public final Cause kind;

  public RuntimeStartFailure(Cause kind, String message, Throwable reason) {
    super(message, reason);
    if (kind == null) throw new IllegalArgumentException("Start failure cause is required");
    this.kind = kind;
  }

  public static Cause of(Throwable failure) {
    if (failure instanceof RuntimeStartFailure) return ((RuntimeStartFailure) failure).kind;
    if (failure instanceof NativeProcessSupervisor.RestartsExhausted) return Cause.CRASHED;
    return Cause.RUNTIME;
  }

  public static String name(Throwable failure) { return of(failure).name().toLowerCase(Locale.ROOT); }
}
