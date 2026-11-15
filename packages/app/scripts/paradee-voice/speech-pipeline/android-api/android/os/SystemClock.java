package android.os;

/** Test double: a clock the test moves. */
public final class SystemClock {
    public static volatile long now = 1_000_000;

    public static long elapsedRealtime() {
        return now;
    }
}
