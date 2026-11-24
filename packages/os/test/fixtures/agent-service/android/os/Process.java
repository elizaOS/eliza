package android.os;

public final class Process {
  public static int myUid() {
    throw new AssertionError("NativeAsk must use its injected link");
  }
}
