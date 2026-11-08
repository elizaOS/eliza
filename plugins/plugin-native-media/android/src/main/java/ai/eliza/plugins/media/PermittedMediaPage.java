package ai.eliza.plugins.media;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * A position in the permitted library's newest-first listing. The library is several MediaStore
 * buckets (each volume's images and videos); a page merges them by date added, then bucket, then
 * row id, because date_added is in seconds and row ids are per collection. The position keeps the
 * last row taken from each bucket. Pure Java so JVM tests can check it without the Android
 * framework.
 */
public final class PermittedMediaPage {
  /** Per bucket, the date_added and _id of the last row taken; MAX_VALUE before the first row. */
  private final long[] dates, ids;
  public PermittedMediaPage(int buckets) {
    dates = new long[buckets];
    ids = new long[buckets];
    Arrays.fill(dates, Long.MAX_VALUE);
    Arrays.fill(ids, Long.MAX_VALUE);
  }
  private PermittedMediaPage(long[] dates, long[] ids) {
    this.dates = dates;
    this.ids = ids;
  }
  /** Refuses a position made for a different bucket list, so the caller restarts from page one. */
  public void requireBuckets(int buckets) {
    if (dates.length != buckets)
      throw new IllegalStateException("Photo page expired; refresh Photos");
  }
  /** Bindings for {@code (date_added<? OR (date_added=? AND _id<?))} on one bucket. */
  public String[] after(int bucket) {
    return new String[] {Long.toString(dates[bucket]), Long.toString(dates[bucket]),
        Long.toString(ids[bucket])};
  }
  public static final class Row<T> {
    final int bucket;
    final long date, id;
    public final T value;
    public Row(int bucket, long date, long id, T value) {
      this.bucket = bucket;
      this.date = date;
      this.id = id;
      this.value = value;
    }
  }
  public static final class Merged<T> {
    public final List<T> items;
    /** Null when the page took every remaining row. */
    public final PermittedMediaPage next;
    Merged(List<T> items, PermittedMediaPage next) {
      this.items = items;
      this.next = next;
    }
  }
  /**
   * Takes the first {@code limit} of the rows each bucket returned after its position. Each bucket
   * must return up to {@code limit + 1} rows in date_added then _id descending order.
   */
  public <T> Merged<T> merge(List<Row<T>> rows, int limit) {
    List<Row<T>> sorted = new ArrayList<>(rows);
    Collections.sort(sorted, (a, b) -> {
      if (a.date != b.date)
        return Long.compare(b.date, a.date);
      if (a.bucket != b.bucket)
        return Integer.compare(a.bucket, b.bucket);
      return Long.compare(b.id, a.id);
    });
    long[] nextDates = dates.clone(), nextIds = ids.clone();
    List<T> items = new ArrayList<>();
    for (Row<T> row : sorted.subList(0, Math.min(limit, sorted.size()))) {
      if (row.bucket < 0 || row.bucket >= dates.length)
        throw new IllegalArgumentException("Unknown media bucket");
      nextDates[row.bucket] = row.date;
      nextIds[row.bucket] = row.id;
      items.add(row.value);
    }
    return new Merged<>(
        items, sorted.size() > limit ? new PermittedMediaPage(nextDates, nextIds) : null);
  }
}
