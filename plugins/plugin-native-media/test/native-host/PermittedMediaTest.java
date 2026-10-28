import ai.eliza.plugins.media.MediaLibraryKey;
import ai.eliza.plugins.media.OwnedMediaConfig;
import ai.eliza.plugins.media.VideoEditSpec;

/** JVM tests of permitted-library identities, video copy rules and host placement. No Android. */
public final class PermittedMediaTest {
  private static int checks;
  private static void check(boolean value, String label) {
    checks++;
    if (!value)
      throw new AssertionError("Check " + checks + ": " + label);
  }
  private interface Failing {
    void run() throws Exception;
  }
  private static void rejects(Class<? extends Exception> type, Failing body, String label) {
    checks++;
    try {
      body.run();
    } catch (Exception error) {
      if (type.isInstance(error))
        return;
      throw new AssertionError("Check " + checks + " (" + label + "): " + error);
    }
    throw new AssertionError("Check " + checks + " should have been rejected: " + label);
  }

  public static void main(String[] args) throws Exception {
    // Library identities are volume-qualified and kind-specific; ambiguous inputs are refused.
    for (String volume : new String[] {"external_primary", "1234-abcd"})
      for (boolean video : new boolean[] {false, true})
        for (long id : new long[] {1, 99, Long.MAX_VALUE}) {
          MediaLibraryKey expected = new MediaLibraryKey(volume, id, video);
          MediaLibraryKey actual = MediaLibraryKey.parse(expected.toString());
          check(actual.volume.equals(volume) && actual.id == id && actual.video == video,
              "round trip " + expected);
        }
    check(!new MediaLibraryKey("external_primary", 5, false)
              .toString()
              .equals(new MediaLibraryKey("1234-abcd", 5, false).toString()),
        "volumes differ");
    check(!new MediaLibraryKey("external_primary", 5, false)
              .toString()
              .equals(new MediaLibraryKey("external_primary", 5, true).toString()),
        "kinds differ");
    check(new MediaLibraryKey("external_primary", 7, true)
              .toString()
              .equals("m:external_primary:v:7"),
        "wire shape");
    for (String invalid : new String[] {"5", "v:5", "m:external:i:5", "m:internal:i:5",
             "m:external_primary:i:0", "m:external_primary:i:-1", "m:external_primary:i:01",
             "m:external_primary:i:9223372036854775808", "m:external_primary:i:1:extra",
             "m:external_primary:x:1", "m:../external_primary:i:1", "m:10@external_primary:i:1",
             "content://media/external/images/1", "m:external_primary:i:1\u0000", null,
             "m:"
                 + "v".repeat(130) + ":i:1"})
      rejects(
          IllegalArgumentException.class, () -> MediaLibraryKey.parse(invalid), "key " + invalid);
    rejects(IllegalArgumentException.class,
        () -> new MediaLibraryKey("external", 1, false), "aggregate volume");

    // Video copy range and geometry rules.
    long duration = 10_040;
    check(new VideoEditSpec(0, 10.04, 0, false, duration, 1920, 1080).unchanged(duration),
        "the exact full range is unchanged");
    check(new VideoEditSpec(0, 10.0, 0, false, duration, 1920, 1080).unchanged(duration),
        "an end 40 ms short of the duration is the full video, not a trim");
    check(new VideoEditSpec(0, 10.09, 0, false, duration, 1920, 1080).unchanged(duration),
        "an end within 0.05 s past the duration is the full video");
    VideoEditSpec trimmed = new VideoEditSpec(0, 9.98, 0, false, duration, 1920, 1080);
    check(!trimmed.unchanged(duration) && trimmed.endMs == 9_980, "an end 60 ms short is a trim");
    check(new VideoEditSpec(1, 10.0, 0, false, duration, 1920, 1080).endMs == duration,
        "a snapped end keeps a trimmed start");
    check(!new VideoEditSpec(0, 10.0, 90, false, duration, 1920, 1080).unchanged(duration),
        "a rotation is an edit");
    rejects(IllegalArgumentException.class,
        () -> new VideoEditSpec(0, 10.1, 0, false, duration, 1920, 1080), "overshoot");
    rejects(IllegalArgumentException.class,
        () -> new VideoEditSpec(9.95, 10.0, 0, false, duration, 1920, 1080), "too short");
    rejects(IllegalArgumentException.class,
        () -> new VideoEditSpec(0, 1, 45, false, duration, 1920, 1080), "rotation");
    rejects(IllegalArgumentException.class,
        () -> new VideoEditSpec(0, 1, 0, false, 300_001, 1920, 1080), "longer than five minutes");
    rejects(IllegalArgumentException.class,
        () -> new VideoEditSpec(Double.NaN, 1, 0, false, duration, 1920, 1080), "NaN start");
    VideoEditSpec rotated = new VideoEditSpec(0, 5, 90, false, duration, 1920, 1080);
    check(rotated.width == 1080 && rotated.height == 1920, "a quarter turn swaps the output size");
    VideoEditSpec cropped = new VideoEditSpec(0, 5, 0, true, duration, 3840, 2160);
    check(cropped.width == 1920 && cropped.height == 1080 && cropped.width % 2 == 0,
        "crop scales to at most 1920 px and even sizes");
    check(rotated.binding().equals("0:5000:90:false:1080:1920"), "binding names every edit");

    // Host placement: video copies live under Movies/ or DCIM/ with host names.
    String op = "123e4567-e89b-42d3-a456-426614174000";
    OwnedMediaConfig config = OwnedMediaConfig.builder("host")
                                  .edits("Pictures/Host App/Edits/", "Host-edit-")
                                  .captures("Pictures/", "SCAN_")
                                  .videoEdits("Movies/Host App/Edits/", "Host-video-edit-")
                                  .build();
    check(config.videoEditRelativePath.equals("Movies/Host App/Edits/"), "video placement");
    check(config.videoEditName(op).equals("Host-video-edit-" + op + ".mp4"), "video name");
    check(config.preferences("video-copy-results-v1").equals("host-video-copy-results-v1"),
        "journal name");
    check(config.privateName("video-edits").equals("host-video-edits"), "private directory");
    rejects(IllegalArgumentException.class, () -> config.privateName("../edits"), "private name");
    rejects(IllegalArgumentException.class,
        () -> config.videoEditName("123E4567-E89B-42D3-A456-426614174000"), "uppercase operation");
    OwnedMediaConfig photosOnly = OwnedMediaConfig.builder("host")
                                      .edits("Pictures/Edits/", "Host-edit-")
                                      .captures("DCIM/", "SCAN_")
                                      .build();
    check(photosOnly.videoEditRelativePath == null, "video edits are optional");
    rejects(IllegalStateException.class, () -> photosOnly.videoEditName(op), "unconfigured video");
    rejects(IllegalArgumentException.class,
        () -> OwnedMediaConfig.builder("host").videoEdits("Pictures/Edits/", "x"), "video root");
    rejects(IllegalArgumentException.class,
        () -> OwnedMediaConfig.builder("host").videoEdits("Movies/../Download/", "x"), "traversal");
    rejects(IllegalArgumentException.class,
        () -> OwnedMediaConfig.builder("host").edits("Movies/Edits/", "x"), "photo root");
    OwnedMediaConfig dcim = OwnedMediaConfig.builder("host")
                                .edits("DCIM/Edits/", "Host-edit-")
                                .captures("Pictures/", "SCAN_")
                                .videoEdits("DCIM/Video Edits/", "Host-video-")
                                .build();
    check(dcim.videoEditRelativePath.equals("DCIM/Video Edits/"), "DCIM video placement");
    System.out.println(checks + " assertions passed");
  }
}
