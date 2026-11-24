package android.net;

public final class LocalSocketAddress {
  public enum Namespace { FILESYSTEM }

  public LocalSocketAddress(String name, Namespace namespace) {
    throw new AssertionError("NativeAsk must use its injected link");
  }
}
