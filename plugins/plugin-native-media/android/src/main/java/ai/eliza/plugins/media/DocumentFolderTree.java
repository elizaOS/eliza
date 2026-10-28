package ai.eliza.plugins.media;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * One user-selected Storage Access Framework folder tree. The renderer browses it through opaque
 * entry ids ({@link FolderSession}); it never supplies or receives authority from a URI or path,
 * and nothing here asks for broad storage permission or falls back to another provider. Android
 * grants the folder in place: nothing is copied or imported.
 *
 * <p>Every change names the revision the renderer listed (name, type, size, modification time and
 * provider flags) and is refused when the provider's current row differs. Deletion is permanent
 * (providers have no integrated trash here) and needs an explicit confirmation; only empty folders
 * are deleted. A batch applies each item independently and reports every item's outcome; if access
 * ends mid-batch, the items already changed are still reported. Sharing opens Android's chooser and
 * sends nothing until the owner picks an app.
 *
 * <p>The host injects the SharedPreferences name that records the chosen tree (installed hosts keep
 * theirs) and how a document from the tree becomes an opaque selected-document capability (normally
 * {@link SelectedDocuments#authorize}). Call every method except {@link #pickerIntent()} from one
 * serial worker thread, through {@link #guarded(Work)}.
 */
public final class DocumentFolderTree {
  /** One page of a folder. "Load more" continues with an opaque cursor. */
  public static final int PAGE = 250;

  private static final String KEY = "root";
  private static final Pattern PREFERENCES = Pattern.compile("[a-z][a-z0-9-]{0,63}");
  private static final int GRANTS =
      Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

  /** Turns a document from the tree into the host's selected-document capability id. */
  public interface Selector {
    String select(Uri document) throws Exception;
  }

  /** A folder operation run on the host's worker. */
  public interface Work {
    JSObject run() throws Exception;
  }

  private final Context context;
  private final String preferences;
  private final Selector selector;
  private final FolderSession<Uri> session = new FolderSession<>();
  private Uri tree;

  public DocumentFolderTree(Context context, String preferences, Selector selector) {
    if (context == null || selector == null || preferences == null
        || !PREFERENCES.matcher(preferences).matches())
      throw new IllegalArgumentException("Invalid folder tree configuration");
    this.context = context.getApplicationContext();
    this.preferences = preferences;
    this.selector = selector;
  }

  public static JSObject result(String status, String message) {
    JSObject out = new JSObject();
    out.put("status", status);
    out.put("message", message);
    return out;
  }

  /**
   * Runs one operation. Revoked access forgets every capability and asks for the folder again; any
   * other failure is reported as unconfirmed, never as done.
   */
  public JSObject guarded(Work task) {
    try {
      return task.run();
    } catch (SecurityException revoked) {
      session.clear();
      return result("revoked", "Folder access expired. Choose the folder again.");
    } catch (Exception failed) {
      return result(
          "failed",
          "The document provider could not confirm this operation. Refresh before retrying.");
    }
  }

  /** Android's folder picker, asking for persistable read and (when offered) write access. */
  public static Intent pickerIntent() {
    return new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        .addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
  }

  private ContentResolver resolver() {
    return context.getContentResolver();
  }

  private SharedPreferences store() {
    return context.getSharedPreferences(preferences, Context.MODE_PRIVATE);
  }

  private boolean retained(boolean write) {
    if (tree == null) return false;
    for (UriPermission p : resolver().getPersistedUriPermissions())
      if (tree.equals(p.getUri()) && p.isReadPermission() && (!write || p.isWritePermission()))
        return true;
    return false;
  }

  private FolderSession.Entry<Uri> root() {
    if (tree == null) {
      String saved = store().getString(KEY, null);
      if (saved == null) return null;
      tree = Uri.parse(saved);
    }
    if (!retained(false)) throw new SecurityException();
    return session.root(
        DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)));
  }

  private FolderSession.Entry<Uri> entry(String id) {
    if (root() == null) return null;
    return session.get(id);
  }

  private JSObject describe(FolderSession.Entry<Uri> item) throws Exception {
    String[] fields = {
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_FLAGS,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED
    };
    try (Cursor row = resolver().query(item.location(), fields, null, null, null)) {
      if (row == null || !row.moveToFirst()) throw new FileNotFoundException();
      String name = row.getString(0), mime = row.getString(1);
      long flags = row.getLong(2),
          size = row.isNull(3) ? -1 : row.getLong(3),
          modified = row.isNull(4) ? -1 : row.getLong(4);
      boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime),
          write = retained(true);
      JSObject value = new JSObject();
      value.put("id", item.id);
      value.put("parentId", item.parent);
      value.put("name", name);
      value.put("mimeType", mime);
      value.put("directory", directory);
      value.put("size", size);
      value.put("modified", modified);
      value.put("revision", name + "|" + mime + "|" + size + "|" + modified + "|" + flags);
      value.put(
          "canCreate",
          write && directory && (flags & DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) != 0);
      value.put(
          "canRename",
          write
              && item.parent != null
              && (flags & DocumentsContract.Document.FLAG_SUPPORTS_RENAME) != 0);
      value.put(
          "canDelete",
          write
              && item.parent != null
              && (flags & DocumentsContract.Document.FLAG_SUPPORTS_DELETE) != 0);
      value.put(
          "canMove",
          write
              && !directory
              && item.parent != null
              && (flags & DocumentsContract.Document.FLAG_SUPPORTS_MOVE) != 0);
      return value;
    }
  }

  private JSObject list(FolderSession.Entry<Uri> folder) throws Exception {
    return list(folder, 0);
  }

  /** The cursor is the offset into the provider's child query for this folder. */
  private JSObject list(FolderSession.Entry<Uri> folder, int offset) throws Exception {
    if (folder == null)
      return result("unavailable", "Choose a folder in Android to browse its contents.");
    JSObject details = describe(folder);
    if (!details.optBoolean("directory"))
      return result("unsupported", "This selection is not a folder.");
    session.touch(folder);
    Uri children =
        DocumentsContract.buildChildDocumentsUriUsingTree(
            tree, DocumentsContract.getDocumentId(folder.location()));
    JSArray rows = new JSArray();
    boolean truncated = false, full = false;
    int total;
    try (Cursor cursor =
        resolver()
            .query(
                children,
                new String[] {DocumentsContract.Document.COLUMN_DOCUMENT_ID},
                null,
                null,
                null)) {
      if (cursor == null) throw new IllegalStateException();
      total = cursor.getCount();
      if (offset > 0 && !cursor.moveToPosition(offset - 1)) offset = total;
      while (cursor.moveToNext()) {
        if (rows.length() >= PAGE) {
          truncated = true;
          break;
        }
        Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0));
        FolderSession.Entry<Uri> child;
        // Listed entries of this folder stay operable, so a folder larger than the session bound
        // stops here honestly.
        try {
          child = session.authorize(uri, folder.id);
        } catch (IllegalStateException limit) {
          truncated = true;
          full = true;
          break;
        }
        rows.put(describe(child));
      }
    }
    int shown = offset + rows.length();
    JSObject out =
        result(
            "ready",
            full
                ? "Showing "
                    + shown
                    + " of "
                    + total
                    + " entries. This folder is too large to browse further here. Open a subfolder or choose a smaller folder."
                : truncated
                    ? "Showing " + shown + " of " + total + " entries. Load more to continue."
                    : "Folder loaded from Android.");
    out.put("folder", details);
    out.put("entries", rows);
    out.put("truncated", truncated);
    out.put("rootId", session.rootId());
    out.put("offset", offset);
    out.put("total", total);
    if (truncated && !full) out.put("cursor", FolderSession.cursor(folder.id, shown));
    return out;
  }

  /**
   * Adopts the tree the owner chose in {@link #pickerIntent()}: only a content tree with a read
   * grant, persisted before it is recorded. The previously recorded tree's grant is released;
   * individually selected documents keep their own grants.
   */
  public JSObject adopt(Uri uri, int grantFlags) throws Exception {
    int flags = grantFlags & GRANTS;
    if (uri == null
        || !"content".equals(uri.getScheme())
        || !DocumentsContract.isTreeUri(uri)
        || (flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0)
      return result("unsupported", "The provider did not grant readable folder access.");
    String previous = store().getString(KEY, null);
    resolver()
        .takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | ((flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
                    ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    : 0));
    if (!store().edit().putString(KEY, uri.toString()).commit())
      return result("failed", "Folder access could not be saved. Choose the folder again.");
    tree = uri;
    session.clear();
    if (previous != null && !previous.equals(uri.toString())) release(previous);
    return list(root());
  }

  private void release(String recorded) {
    for (UriPermission permission : resolver().getPersistedUriPermissions())
      if (recorded.equals(permission.getUri().toString())) {
        try {
          resolver()
              .releasePersistableUriPermission(
                  permission.getUri(),
                  (permission.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
                      | (permission.isWritePermission()
                          ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                          : 0));
        } catch (SecurityException alreadyGone) {
          // The grant is already gone; nothing remains to release.
        }
        break;
      }
  }

  /** The root (no id) or a listed folder; a cursor continues that folder's listing. */
  public JSObject list(String id, String cursor) throws Exception {
    FolderSession.Entry<Uri> root = root();
    FolderSession.Entry<Uri> folder = id == null ? root : entry(id);
    if (cursor == null) return list(folder);
    int offset =
        folder == null ? FolderSession.OTHER_FOLDER : FolderSession.cursorOffset(cursor, folder.id);
    if (offset == FolderSession.OTHER_FOLDER)
      return result("conflict", "This folder changed. Refresh it before loading more.");
    if (offset < 1) return result("conflict", "Refresh this folder before loading more.");
    return list(folder, offset);
  }

  private static JSObject outcome(String id, String status, String message) {
    JSObject value = result(status, message);
    value.put("id", id);
    return value;
  }

  private static boolean current(JSObject row, String expectedRevision) throws Exception {
    return row.getString("revision").equals(expectedRevision);
  }

  /**
   * Per-item move or permanent delete of 1-100 listed items. Each item is checked against its
   * listed revision and applied independently; the result names every item's outcome.
   */
  public JSObject changeMany(
      JSArray items, String action, boolean confirmPermanent, String destinationId)
      throws Exception {
    String verb0 = action == null ? "" : action;
    if (items == null || items.length() < 1 || items.length() > 100)
      return result("unsupported", "Select between 1 and 100 items.");
    if (!verb0.equals("move") && !verb0.equals("delete"))
      return result("unsupported", "Choose move or delete.");
    boolean move = verb0.equals("move");
    if (!move && !confirmPermanent)
      return result(
          "confirmation-required",
          "Permanently delete the selected items? This provider has no integrated trash or undo.");
    FolderSession.Entry<Uri> destination = move ? entry(destinationId) : null;
    if (move) {
      if (destination == null) return result("revoked", "Reload the destination folder first.");
      if (!describe(destination).optBoolean("canCreate"))
        return result("unsupported", "This provider does not allow moving files into that folder.");
    }
    JSArray outcomes = new JSArray();
    int done = 0;
    boolean expired = false;
    Set<String> seen = new HashSet<>();
    for (int i = 0; i < items.length() && !expired; i++) {
      JSONObject request = items.optJSONObject(i);
      String id = request == null ? "" : request.optString("id", "");
      String expected = request == null ? "" : request.optString("expectedRevision", "");
      if (!seen.add(id)) {
        outcomes.put(outcome(id, "unsupported", "Duplicate selection."));
        continue;
      }
      FolderSession.Entry<Uri> item = entry(id);
      if (item == null) {
        outcomes.put(outcome(id, "revoked", "Reload this folder first."));
        continue;
      }
      try {
        JSObject info = describe(item);
        if (!current(info, expected)) {
          outcomes.put(outcome(id, "conflict", "Changed since it was listed."));
          continue;
        }
        if (!move) {
          if (!info.optBoolean("canDelete")) {
            outcomes.put(outcome(id, "unsupported", "This provider does not permit deleting it."));
            continue;
          }
          if (info.optBoolean("directory") && list(item).getJSONArray("entries").length() > 0) {
            outcomes.put(outcome(id, "unsupported", "Only empty folders can be deleted here."));
            continue;
          }
          if (!DocumentsContract.deleteDocument(resolver(), item.location())) {
            outcomes.put(outcome(id, "failed", "Deletion was not confirmed."));
            continue;
          }
          session.remove(item.id);
          outcomes.put(outcome(id, "deleted", "Permanently deleted."));
          done++;
        } else {
          if (!info.optBoolean("canMove")) {
            outcomes.put(outcome(id, "unsupported", "This provider does not support moving it."));
            continue;
          }
          if (destination.id.equals(item.parent)) {
            outcomes.put(outcome(id, "unsupported", "Already in that folder."));
            continue;
          }
          // The listed parent can leave the bounded session; the item then needs a reload, not a
          // revoked session.
          FolderSession.Entry<Uri> parent = entry(item.parent);
          if (parent == null) {
            outcomes.put(outcome(id, "revoked", "Reload this folder first."));
            continue;
          }
          Uri moved =
              DocumentsContract.moveDocument(
                  resolver(), item.location(), parent.location(), destination.location());
          if (moved == null) {
            outcomes.put(outcome(id, "failed", "Move was not confirmed."));
            continue;
          }
          session.remove(item.id);
          session.authorize(moved, destination.id);
          outcomes.put(outcome(id, "moved", "Moved."));
          done++;
        }
      } catch (SecurityException revoked) {
        // Access ended mid-batch: earlier items already changed, so their outcomes are still
        // reported.
        expired = true;
        outcomes.put(outcome(id, "revoked", "Folder access expired before this item."));
      } catch (Exception failed) {
        outcomes.put(
            outcome(
                id, "failed", "The provider could not confirm this item. Refresh before retrying."));
      }
    }
    String verb = move ? "moved" : "deleted";
    if (expired) {
      session.clear();
      JSObject out =
          result(
              done > 0 ? "partial" : "revoked",
              done > 0
                  ? done
                      + " of "
                      + items.length()
                      + " items "
                      + verb
                      + " before folder access expired. Choose the folder again and review the items that remain."
                  : "Folder access expired. Nothing was " + verb + ". Choose the folder again.");
      out.put("outcomes", outcomes);
      out.put("count", done);
      return out;
    }
    JSObject out =
        result(
            done == items.length() ? verb : done > 0 ? "partial" : "failed",
            done == items.length()
                ? (done == 1 ? "1 item " : done + " items ")
                    + (move ? "moved." : "permanently deleted.")
                : done > 0
                    ? done + " of " + items.length() + " items " + verb + ". Review the items that remain."
                    : "No items were " + verb + ". Refresh the folder and review each item.");
    out.put("outcomes", outcomes);
    out.put("count", done);
    return out;
  }

  /**
   * One share sheet for 1-100 listed files. Folders and changed items are skipped and reported;
   * nothing is sent until the owner picks an app.
   */
  public JSObject shareMany(Activity activity, JSArray items) throws Exception {
    if (items == null || items.length() < 1 || items.length() > 100)
      return result("unsupported", "Select between 1 and 100 items.");
    ArrayList<Uri> uris = new ArrayList<>();
    JSArray outcomes = new JSArray();
    Set<String> types = new HashSet<>();
    for (int i = 0; i < items.length(); i++) {
      JSONObject request = items.optJSONObject(i);
      String id = request == null ? "" : request.optString("id", "");
      FolderSession.Entry<Uri> item = entry(id);
      if (item == null) {
        outcomes.put(outcome(id, "revoked", "Reload this folder first."));
        continue;
      }
      JSObject info = describe(item);
      if (!current(info, request.optString("expectedRevision", ""))) {
        outcomes.put(outcome(id, "conflict", "Changed since it was listed."));
        continue;
      }
      if (info.optBoolean("directory")) {
        outcomes.put(
            outcome(
                id, "unsupported", "Folders cannot be shared. Open the folder and select files."));
        continue;
      }
      uris.add(item.location());
      types.add(info.getString("mimeType"));
      outcomes.put(outcome(id, "included", "Included."));
    }
    if (uris.isEmpty()) {
      JSObject out = result("unsupported", "None of the selected items can be shared.");
      out.put("outcomes", outcomes);
      return out;
    }
    String type = types.size() == 1 ? types.iterator().next() : "*/*";
    Intent send =
        new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE)
            .setType(type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    if (uris.size() == 1) send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
    else send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
    ClipData clip = ClipData.newRawUri("Selected files", uris.get(0));
    for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
    send.setClipData(clip);
    if (activity == null) return result("unavailable", "Files closed. Reopen Files to share.");
    CountDownLatch started = new CountDownLatch(1);
    boolean[] opened = {false};
    activity.runOnUiThread(
        () -> {
          try {
            activity.startActivity(Intent.createChooser(send, "Share"));
            opened[0] = true;
          } catch (RuntimeException unavailable) {
            opened[0] = false;
          } finally {
            started.countDown();
          }
        });
    if (!started.await(5, TimeUnit.SECONDS) || !opened[0])
      return result("failed", "Android could not open sharing for these files.");
    JSObject out =
        result(
            "opened",
            "Choose an app to share "
                + uris.size()
                + (uris.size() == 1 ? " file" : " files")
                + (outcomes.length() > uris.size() ? ". Some selected items were skipped" : "")
                + ". Nothing has been sent yet.");
    out.put("outcomes", outcomes);
    out.put("count", uris.size());
    return out;
  }

  public JSObject createFolder(String id, String name) throws Exception {
    FolderSession.Entry<Uri> folder = entry(id);
    if (folder == null) return result("revoked", "Reload this folder first.");
    JSObject info = describe(folder);
    if (!info.optBoolean("canCreate"))
      return result("unsupported", "This provider does not permit folder creation.");
    Uri created =
        DocumentsContract.createDocument(
            resolver(),
            folder.location(),
            DocumentsContract.Document.MIME_TYPE_DIR,
            FolderSession.childName(name));
    if (created == null)
      return result(
          "failed", "The provider did not confirm folder creation. Refresh before retrying.");
    JSObject out = result("created", "Folder created.");
    out.put("entry", describe(session.authorize(created, folder.id)));
    return out;
  }

  public JSObject rename(String id, String name, String expectedRevision) throws Exception {
    FolderSession.Entry<Uri> item = entry(id);
    if (item == null) return result("revoked", "Reload this folder first.");
    JSObject info = describe(item);
    if (!info.optBoolean("canRename"))
      return result("unsupported", "This provider does not permit renaming this item.");
    if (!current(info, expectedRevision))
      return result("conflict", "This item changed. Refresh before renaming.");
    Uri renamed =
        DocumentsContract.renameDocument(resolver(), item.location(), FolderSession.childName(name));
    if (renamed == null)
      return result("failed", "Rename was not confirmed. Refresh before retrying.");
    session.renamed(item, renamed);
    JSObject out = result("renamed", "Item renamed.");
    out.put("entry", describe(item));
    return out;
  }

  public JSObject delete(String id, boolean confirmPermanent, String expectedRevision)
      throws Exception {
    FolderSession.Entry<Uri> item = entry(id);
    if (item == null) return result("revoked", "Reload this folder first.");
    JSObject info = describe(item);
    if (!info.optBoolean("canDelete"))
      return result("unsupported", "This provider does not permit deletion.");
    if (!confirmPermanent)
      return result(
          "confirmation-required",
          "Permanently delete this item? This provider has no integrated trash or undo.");
    if (!current(info, expectedRevision))
      return result("conflict", "This item changed. Refresh before deleting.");
    if (info.optBoolean("directory")) {
      JSObject contents = list(item);
      if (contents.getJSONArray("entries").length() > 0)
        return result(
            "unsupported",
            "Only empty folders can be deleted here. Manage nonempty folders in Android Files.");
    }
    if (!DocumentsContract.deleteDocument(resolver(), item.location()))
      return result("failed", "Deletion was not confirmed. Refresh before retrying.");
    session.remove(item.id);
    return result("deleted", "Item permanently deleted.");
  }

  public JSObject move(String id, String destinationId, String expectedRevision) throws Exception {
    FolderSession.Entry<Uri> item = entry(id), destination = entry(destinationId);
    if (item == null || destination == null)
      return result("revoked", "Reload source and destination folders first.");
    JSObject info = describe(item), target = describe(destination);
    if (!info.optBoolean("canMove") || !target.optBoolean("canCreate"))
      return result("unsupported", "This provider does not support moving this file to that folder.");
    if (!current(info, expectedRevision))
      return result("conflict", "This file changed. Refresh before moving.");
    if (destination.id.equals(item.parent))
      return result("unsupported", "This file is already in that folder.");
    FolderSession.Entry<Uri> parent = entry(item.parent);
    if (parent == null) return result("revoked", "Reload source and destination folders first.");
    Uri moved =
        DocumentsContract.moveDocument(
            resolver(), item.location(), parent.location(), destination.location());
    if (moved == null)
      return result("failed", "Move was not confirmed. Refresh both folders before retrying.");
    session.remove(item.id);
    JSObject out = result("moved", "File moved.");
    out.put("entry", describe(session.authorize(moved, destination.id)));
    return out;
  }

  /** Hands one listed document to the host as a selected-document capability. */
  public JSObject select(String id) throws Exception {
    FolderSession.Entry<Uri> item = entry(id);
    if (item == null) return result("revoked", "Reload this folder first.");
    JSObject info = describe(item);
    if (info.optBoolean("directory"))
      return result("unsupported", "Open this folder to browse its contents.");
    String selectionId = selector.select(item.location());
    JSObject out = result("selected", "Document selected from your chosen folder.");
    out.put("action", "files");
    out.put("selectionId", selectionId);
    out.put("name", info.getString("name"));
    out.put("mimeType", info.getString("mimeType"));
    out.put("uri", item.location().toString());
    out.put("canRename", info.optBoolean("canRename"));
    return out;
  }

  /** Forgets the recorded tree and releases its grant. Selected documents keep their grants. */
  public JSObject forget() throws Exception {
    Uri old = tree;
    if (old == null) {
      String saved = store().getString(KEY, null);
      if (saved != null) old = Uri.parse(saved);
    }
    if (!store().edit().remove(KEY).commit())
      return result("failed", "Folder selection could not be forgotten.");
    tree = null;
    session.clear();
    if (old != null)
      for (UriPermission p : resolver().getPersistedUriPermissions())
        if (old.equals(p.getUri())) {
          int flags =
              (p.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
                  | (p.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
          resolver().releasePersistableUriPermission(old, flags & GRANTS);
          break;
        }
    return result("forgotten", "Folder access released.");
  }
}
