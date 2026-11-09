package android.os;
/** Test double: the host's monotonic clock. */
public final class SystemClock {
 public static long elapsedRealtime(){return System.nanoTime()/1_000_000L;}
}
