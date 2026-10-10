import ai.eliza.plugins.media.CaptureAdmission;
import ai.eliza.plugins.media.OwnedMediaSelection;
import java.util.Base64;

/** JVM tests with synthetic bytes only; no Android framework. */
public final class OwnedCapturesTest {
  private static int checks;
  private static void check(boolean value) {
    checks++;
    if (!value)
      throw new AssertionError("Check " + checks);
  }
  private interface Failing {
    void run() throws Exception;
  }
  private static void rejects(Failing body) {
    checks++;
    try {
      body.run();
    } catch (IllegalArgumentException expected) {
      return;
    } catch (Exception other) {
      throw new AssertionError("Check " + checks + ": " + other);
    }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }
  public static void main(String[] args) {
    byte[] jpeg = {(byte) 0xFF, (byte) 0xD8, 1, 2, 3, (byte) 0xFF, (byte) 0xD9};
    check(CaptureAdmission.jpeg(Base64.getEncoder().encodeToString(jpeg)).length == jpeg.length);
    rejects(() -> CaptureAdmission.jpeg(null));
    rejects(() -> CaptureAdmission.jpeg("not base64!"));
    rejects(()
                -> CaptureAdmission.jpeg(Base64.getEncoder().encodeToString(
                    new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 0})));
    rejects(()
                -> CaptureAdmission.jpeg(
                    Base64.getEncoder().encodeToString(new byte[] {(byte) 0xFF, (byte) 0xD8, 1})));
    byte[] large = new byte[CaptureAdmission.MAX_BYTES + 2];
    large[0] = (byte) 0xFF;
    large[1] = (byte) 0xD8;
    rejects(() -> CaptureAdmission.jpeg(Base64.getEncoder().encodeToString(large)));

    check(OwnedMediaSelection.owned(29, false).equals("owner_package_name=? AND is_pending=0"));
    check(OwnedMediaSelection.owned(34, true).equals(
        "owner_package_name=? AND is_pending=0 AND is_trashed=1"));
    rejects(() -> OwnedMediaSelection.owned(29, true));
    check(OwnedMediaSelection.page(34, false, "videos")
            .endsWith(" AND media_type IN (1,3) AND media_type=3 AND _id<?"));
    check(OwnedMediaSelection.page(34, false, "favorites").contains("is_favorite=1"));
    rejects(() -> OwnedMediaSelection.page(29, false, "favorites"));
    rejects(() -> OwnedMediaSelection.page(34, true, "videos"));
    rejects(() -> OwnedMediaSelection.page(34, false, "x' OR 1=1"));
    check(!OwnedMediaSelection.page(34, false, "").contains("'"));
    check(OwnedMediaSelection.revision(29, 10, 20, 30, 0).equals("10:20"));
    check(OwnedMediaSelection.revision(34, 10, 20, 30, 1).equals("10:20:30:1"));
    check(OwnedMediaSelection.cursor("") == Long.MAX_VALUE);
    check(OwnedMediaSelection.cursor("42") == 42);
    rejects(() -> OwnedMediaSelection.cursor("0"));
    rejects(() -> OwnedMediaSelection.cursor("-5"));
    rejects(() -> OwnedMediaSelection.cursor("abc"));
    System.out.println(checks + " assertions passed");
  }
}
