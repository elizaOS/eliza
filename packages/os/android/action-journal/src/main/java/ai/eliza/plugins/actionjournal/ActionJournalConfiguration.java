package ai.eliza.plugins.actionjournal;

/**
 * Migration-sensitive journal identity and bounds. The namespace prefixes every storage slot
 * ({@code <namespace>:<scope>:index} and {@code <namespace>:<scope>:entry:<proposalId>}), so a host
 * adopting this module must keep its existing namespace. No request can override it.
 */
public final class ActionJournalConfiguration {
 public final String namespace;
 public final int maxEntries, maxRecordChars, maxSummaryChars;

 public ActionJournalConfiguration(String namespace, int maxEntries, int maxRecordChars, int maxSummaryChars) {
  if (namespace == null || !namespace.matches("[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9][a-z0-9._-]{0,63}){0,3}")) throw new IllegalArgumentException("Invalid journal namespace");
  if (maxEntries < 1 || maxEntries > 65536 || maxRecordChars < 256 || maxRecordChars > 1_000_000 || maxSummaryChars < 1 || maxSummaryChars > 100_000)
   throw new IllegalArgumentException("Invalid journal bounds");
  this.namespace = namespace;
  this.maxEntries = maxEntries;
  this.maxRecordChars = maxRecordChars;
  this.maxSummaryChars = maxSummaryChars;
 }

 /** The bounds used by the first host: 2048 entries, 64000-character records, 2000-character summaries. */
 public static ActionJournalConfiguration standard(String namespace) { return new ActionJournalConfiguration(namespace, 2048, 64000, 2000); }
}
