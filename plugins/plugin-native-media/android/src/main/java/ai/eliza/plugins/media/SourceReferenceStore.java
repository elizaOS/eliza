package ai.eliza.plugins.media;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Durable source links for saved items (for example a note summarizing a selected document). A
 * reference is retained only while Android holds a persisted read grant on the document or a tree
 * that contains it; each retain (re)starts its stored grace period, so a link asked about but not
 * yet saved survives a restart for {@link SourceReferences#GRACE_MS}. {@link #reconcile} removes
 * references no saved or restorable item names once their grace has passed and asks the host to
 * release each orphaned document grant. The host supplies its installed preference names.
 */
public final class SourceReferenceStore {
  private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9-]{0,63}");
  private final Context context;
  private final String referencesName, retainedName;
  private final long grace;

  /** Counts from one reconciliation pass. */
  public static final class Reconciled {
    public final int removed, released, remaining;
    Reconciled(int removed, int released, int remaining) {
      this.removed = removed;
      this.released = released;
      this.remaining = remaining;
    }
  }

  public SourceReferenceStore(Context context, String referencesName, String retainedName) {
    this(context, referencesName, retainedName, SourceReferences.GRACE_MS);
  }

  public SourceReferenceStore(
      Context context, String referencesName, String retainedName, long grace) {
    if (referencesName == null || !NAME.matcher(referencesName).matches() || retainedName == null
        || !NAME.matcher(retainedName).matches() || referencesName.equals(retainedName)
        || grace < 0)
      throw new IllegalArgumentException("Invalid source reference storage");
    this.context = context.getApplicationContext();
    this.referencesName = referencesName;
    this.retainedName = retainedName;
    this.grace = grace;
  }

  private SharedPreferences references() {
    return context.getSharedPreferences(referencesName, 0);
  }

  private SharedPreferences retained() {
    return context.getSharedPreferences(retainedName, 0);
  }

  /** Whether Android holds a persisted read grant on this document or on a tree containing it. */
  public static boolean persistedReadAccess(ContentResolver resolver, Uri uri) {
    Uri tree = null;
    try {
      if (DocumentsContract.isTreeUri(uri))
        tree = DocumentsContract.buildTreeDocumentUri(
            uri.getAuthority(), DocumentsContract.getTreeDocumentId(uri));
    } catch (RuntimeException ignored) {
      // A document URI that is not tree-scoped has no covering tree grant.
    }
    for (UriPermission grant : resolver.getPersistedUriPermissions())
      if (grant.isReadPermission() && (grant.getUri().equals(uri) || grant.getUri().equals(tree)))
        return true;
    return false;
  }

  /** True when any stored reference names this document URI; its grant must then be kept. */
  public boolean retains(String uri) {
    return SourceReferences.referenced(references().getAll(), uri);
  }

  /**
   * Stores a reference to a document whose persisted read grant Android holds and (re)starts its
   * grace period. Returns null, storing nothing, when there is no persisted grant, the URI is too
   * long or the store is full of other references.
   */
  public String retain(Uri uri, long now) throws Exception {
    if (uri == null || !"content".equals(uri.getScheme())
        || uri.toString().length() > SourceReferences.URI_LIMIT
        || !persistedReadAccess(context.getContentResolver(), uri))
      return null;
    String reference = SourceReferences.reference(uri.toString());
    SharedPreferences refs = references();
    if (!refs.contains(reference) && refs.getAll().size() >= SourceReferences.LIMIT)
      return null;
    // The retain time is written first, so a stored reference always has a grace period.
    if (!retained().edit().putLong(reference, now).commit()
        || !refs.edit().putString(reference, uri.toString()).commit())
      throw new IOException("Source reference could not be stored");
    return reference;
  }

  /**
   * The document a stored reference names, only while Android still holds a persisted read grant
   * on it. Throws SecurityException for an invalid reference or ended access and IOException when
   * the reference is not stored.
   */
  public Uri resolve(String reference) throws IOException {
    if (!SourceReferences.valid(reference))
      throw new SecurityException("Invalid source reference");
    String stored = references().getString(reference, null);
    if (stored == null)
      throw new IOException("Source reference is not stored");
    Uri uri = Uri.parse(stored);
    if (!"content".equals(uri.getScheme())
        || !persistedReadAccess(context.getContentResolver(), uri))
      throw new SecurityException("Source access ended");
    return uri;
  }

  /**
   * Keeps every reference in {@code keep} (all saved and restorable items' links) and every
   * reference retained within the grace period; removes the rest, then asks {@code release} to
   * release the grant of each removed document that no remaining reference names.
   */
  public Reconciled reconcile(Set<String> keep, long now, Predicate<Uri> release)
      throws IOException {
    for (String value : keep)
      if (!SourceReferences.valid(value))
        throw new IllegalArgumentException("Invalid source reference");
    SharedPreferences refs = references(), times = retained();
    Map<String, ?> all = refs.getAll();
    // A reference without a usable retain time starts its grace period now instead of being pruned.
    List<String> seed = SourceReferences.unseeded(all, times.getAll(), now);
    if (!seed.isEmpty()) {
      SharedPreferences.Editor edit = times.edit();
      for (String key : seed) edit.putLong(key, now);
      if (!edit.commit())
        throw new IOException("Source reference times could not be stored");
    }
    List<String> drop = SourceReferences.unreferenced(all, keep, times.getAll(), now, grace);
    int released = 0;
    if (!drop.isEmpty()) {
      SharedPreferences.Editor edit = refs.edit();
      for (String key : drop) edit.remove(key);
      if (!edit.commit())
        throw new IOException("Source references could not be removed");
    }
    {
      SharedPreferences.Editor edit = times.edit();
      boolean stale = false;
      for (String key : times.getAll().keySet())
        if (!refs.contains(key)) {
          edit.remove(key);
          stale = true;
        }
      if (stale)
        edit.commit();
    }
    for (String uri : SourceReferences.orphaned(all, drop))
      if (release != null && release.test(Uri.parse(uri)))
        released++;
    return new Reconciled(drop.size(), released, refs.getAll().size());
  }
}
