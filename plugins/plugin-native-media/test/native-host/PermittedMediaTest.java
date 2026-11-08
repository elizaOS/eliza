import ai.eliza.plugins.media.MediaLibraryKey;
import ai.eliza.plugins.media.OwnedMediaConfig;
import ai.eliza.plugins.media.PermittedMediaChange;
import ai.eliza.plugins.media.PermittedMediaPage;
import ai.eliza.plugins.media.VideoEditSpec;
import java.util.ArrayList;
import java.util.List;

/**
 * JVM tests of permitted-library identities and revisions, page merging, change review, video copy
 * rules and host placement. No Android.
 */
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

  /** One synthetic MediaStore bucket of {date_added, _id} rows, read as the catalog reads it. */
  private static List<PermittedMediaPage.Row<String>> bucketRows(
      PermittedMediaPage position, int bucket, long[][] rows, String name, int limit) {
    String[] after = position.after(bucket);
    long date = Long.parseLong(after[0]), id = Long.parseLong(after[2]);
    List<long[]> matching = new ArrayList<>();
    for (long[] row : rows)
      if (row[0] < date || (row[0] == date && row[1] < id))
        matching.add(row);
    matching.sort((a, b) -> a[0] != b[0] ? Long.compare(b[0], a[0]) : Long.compare(b[1], a[1]));
    List<PermittedMediaPage.Row<String>> result = new ArrayList<>();
    for (long[] row : matching.subList(0, Math.min(limit + 1, matching.size())))
      result.add(new PermittedMediaPage.Row<>(bucket, row[0], row[1], name + row[1]));
    return result;
  }
  /** Every page of the merged listing, each page's items joined in order. */
  private static List<List<String>> pages(long[][][] buckets, String[] names, int limit) {
    List<List<String>> result = new ArrayList<>();
    PermittedMediaPage position = new PermittedMediaPage(buckets.length);
    while (position != null) {
      position.requireBuckets(buckets.length);
      List<PermittedMediaPage.Row<String>> rows = new ArrayList<>();
      for (int bucket = 0; bucket < buckets.length; bucket++)
        rows.addAll(bucketRows(position, bucket, buckets[bucket], names[bucket], limit));
      PermittedMediaPage.Merged<String> merged = position.merge(rows, limit);
      result.add(merged.items);
      position = merged.next;
    }
    return result;
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

    // Revisions keep one colon-free prefix whatever MediaStore.getVersion returns. The pattern is
    // PERMITTED_REVISION in plugin-assistant's photo-library-contract.ts.
    String permittedRevision = "[a-zA-Z0-9_-]{1,128}(?::[0-9]{1,19}){3,5}";
    for (String version : new String[] {"17:3f2c9a6e-1b4d-4c8a-9e2f-5a6b7c8d9e0f",
             "a1b2c3d4e5f60708", "\u00e9:/+="}) {
      String prefix = MediaLibraryKey.revisionPrefix(version);
      check(prefix.length() == 43, "digest length " + version);
      check((prefix + ":1700000000:2048:1700000001:10:11").matches(permittedRevision),
          "revision shape " + version);
    }
    check(!("17:3f2c9a6e-1b4d-4c8a-9e2f-5a6b7c8d9e0f:1700000000:2048:1700000001")
              .matches(permittedRevision),
        "a raw version:uuid prefix does not fit the wire shape");
    String same = MediaLibraryKey.revisionPrefix("17:a");
    check(same.equals(MediaLibraryKey.revisionPrefix("17:a"))
            && !same.equals(MediaLibraryKey.revisionPrefix("18:a")),
        "a new provider version changes the revision");

    // Library pages merge every bucket by date added, so a new video is not listed after older
    // images. Equal dates order by bucket (images before videos), then by row id.
    long[][] images = new long[30][];
    for (int i = 0; i < 30; i++) images[i] = new long[] {1_000 + i, i + 1};
    long[][] newVideo = {{5_000, 1}};
    List<List<String>> mixed = pages(new long[][][] {images, newVideo}, new String[] {"i", "v"}, 24);
    check(mixed.get(0).get(0).equals("v1"), "the newest video leads page one");
    check(mixed.size() == 2 && mixed.get(0).size() == 24 && mixed.get(1).size() == 7,
        "31 rows fill one page and part of the next");
    List<String> all = new ArrayList<>();
    for (List<String> page : mixed) all.addAll(page);
    List<String> expected = new ArrayList<>();
    expected.add("v1");
    for (int i = 30; i >= 1; i--) expected.add("i" + i);
    check(all.equals(expected), "every row once, newest first");
    long[][] spread = new long[20][], spreadVideos = new long[20][], secondVolume = new long[20][];
    for (int i = 0; i < 20; i++) {
      spread[i] = new long[] {100 + 3 * i, 50 + i};
      spreadVideos[i] = new long[] {101 + 3 * i, 7 + i};
      secondVolume[i] = new long[] {102 + 3 * i, 50 + i};
    }
    List<String> merged = new ArrayList<>();
    for (List<String> page :
        pages(new long[][][] {spread, spreadVideos, secondVolume}, new String[] {"a", "b", "c"}, 7))
      merged.addAll(page);
    check(merged.size() == 60 && new java.util.HashSet<>(merged).size() == 60,
        "small pages across three buckets yield each row exactly once");
    check(merged.get(0).equals("c69") && merged.get(1).equals("b26") && merged.get(2).equals("a69")
            && merged.get(59).equals("a50"),
        "small pages stay in date order");
    long[][] tiedImages = {{2_000, 9}, {2_000, 4}};
    long[][] tiedVideos = {{2_000, 12}, {2_000, 3}};
    for (int limit : new int[] {1, 2, 3, 24}) {
      List<String> tied = new ArrayList<>();
      for (List<String> page :
          pages(new long[][][] {tiedImages, tiedVideos}, new String[] {"i", "v"}, limit))
        tied.addAll(page);
      check(tied.equals(java.util.Arrays.asList("i9", "i4", "v12", "v3")),
          "equal dates order by bucket then id at page size " + limit);
    }
    PermittedMediaPage onePage = new PermittedMediaPage(2);
    rejects(IllegalStateException.class, () -> onePage.requireBuckets(3),
        "a position from another bucket list");
    check(pages(new long[][][] {{}, {}}, new String[] {"i", "v"}, 24).get(0).isEmpty(),
        "an empty library is one empty page");

    // Change review: the owner's reversible change goes straight to Android's request, which names
    // the action and items; permanent deletion and agent requests keep the app's review.
    check(!PermittedMediaChange.appReview(false, false), "owner reversible change skips dialog");
    check(PermittedMediaChange.appReview(false, true), "agent change keeps app dialog");
    check(PermittedMediaChange.appReview(true, false), "delete forever keeps app dialog");
    check(PermittedMediaChange.title(3, true, true, false).equals("Favorite 3 items?"), "favorite");
    check(PermittedMediaChange.title(1, true, false, false).equals("Unfavorite 1 item?"),
        "unfavorite");
    check(PermittedMediaChange.title(3, false, true, false)
              .equals("Move 3 items to Recently deleted?"),
        "trash");
    check(PermittedMediaChange.title(3, false, false, false).equals("Restore 3 items?"), "restore");
    check(PermittedMediaChange.title(1, false, true, true).equals("Delete 1 item forever?"),
        "delete forever");
    String reversible = PermittedMediaChange.message("1. a.jpg\n", false);
    check(reversible.startsWith("1. a.jpg\n")
            && reversible.contains("Only these items, as they are now, will be changed.")
            && !reversible.contains("revision"),
        "reversible body");
    check(PermittedMediaChange.message("1. a.jpg\n", true)
              .contains("permanently deleted and cannot be recovered"),
        "permanent warning");

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
