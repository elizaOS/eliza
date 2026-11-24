package android.os;

public final class SystemClock {
  public static long elapsedRealtimeNanos() {
    throw new AssertionError("NativeAsk must use its injected clock");
  }
}
