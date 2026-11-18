// spec/os/android/deepLinks.md, "Story: Open the link I followed exactly once, even across a cold start"; spec/os/android/deepLinks.md, "Story: Keep two links I followed apart, even when they are the same URL"
package ai.eliza.plugins.signin;

public final class DeepLinkCapture {

  public record Pending(long receipt, String url) {}

  private record Kept(long captured, long pending, String url) {
    String encode() { return captured + "\n" + pending + "\n" + url; }

    static Kept decode(String raw) {
      if (raw == null) return new Kept(0, 0, "");
      String[] parts = raw.split("\n", 3);
      if (parts.length != 3) throw new IllegalStateException("The deep-link slot is not readable");
      long captured = Long.parseLong(parts[0]), pending = Long.parseLong(parts[1]);
      if (captured < 0 || pending < 0 || pending > captured || (pending == 0) != parts[2].isEmpty())
        throw new IllegalStateException("The deep-link slot is not readable");
      return new Kept(captured, pending, parts[2]);
    }
  }

  private final SecureSlot slot;
  private final Object lock = new Object();
  private long coldLaunch;

  private DeepLinkCapture(SecureSlot slot) { this.slot = slot; }

  public static DeepLinkCapture launch(SecureSlot slot, String coldLaunchUrl) throws Exception {
    DeepLinkCapture capture = new DeepLinkCapture(slot);
    if (coldLaunchUrl != null) capture.coldLaunch = capture.capture(coldLaunchUrl);
    return capture;
  }

  public static boolean admissible(String url) {
    return url != null && !url.isEmpty() && url.indexOf('\n') < 0 && url.indexOf('\r') < 0 && url.equals(url.trim());
  }

  public long capture(String url) throws Exception {
    if (!admissible(url)) throw new IllegalArgumentException("A followed link must be one line of text");
    synchronized (lock) {
      String raw = slot.read();
      Kept now = Kept.decode(raw);
      long receipt = now.captured + 1;
      if (!slot.compareExchange(raw, new Kept(receipt, receipt, url).encode()))
        throw new IllegalStateException("The deep-link slot changed during a capture");
      return receipt;
    }
  }

  public Pending pending() throws Exception {
    synchronized (lock) {
      Kept now = Kept.decode(slot.read());
      return now.pending == 0 ? null : new Pending(now.pending, now.url);
    }
  }

  public boolean acknowledge(long receipt, String url) throws Exception {
    synchronized (lock) {
      String raw = slot.read();
      Kept now = Kept.decode(raw);
      if (receipt <= 0 || now.pending != receipt || !now.url.equals(url)) return false;
      return slot.compareExchange(raw, new Kept(now.captured, 0, "").encode());
    }
  }

  public long captured() throws Exception {
    synchronized (lock) { return Kept.decode(slot.read()).captured; }
  }

  public long coldLaunch() { return coldLaunch; }
}
