package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native CSV transfer. One request owns its picker, fresh unlock, review and I/O.
 * Results contain counts only. No credential or document bytes cross the bridge. */
@CapacitorPlugin(name = "ElizaPasswordTransfer")
public class PasswordTransferPlugin extends Plugin {
  private enum Phase { REVIEW, PICKER, AUTH, IO }
  private static final class Transfer {
    final PluginCall call;
    final PasswordVaultAccess access;
    final boolean exporting;
    final CancellationSignal cancellation = new CancellationSignal();
    volatile boolean cancelled;
    long ticket;
    Phase phase = Phase.REVIEW;
    int workers;
    boolean settled;
    AlertDialog dialog;
    PasswordCsv.Import parsed;
    Closeable stream;
    Transfer(PluginCall call, PasswordVaultAccess access, boolean exporting) {
      this.call = call; this.access = access; this.exporting = exporting;
    }
    synchronized void attach(Closeable value) throws Exception {
      if (cancelled) { value.close(); throw new PasswordVaultAccess.Locked(); }
      stream = value;
    }
    synchronized void closeStream() {
      if (stream != null) { try { stream.close(); } catch (Exception ignored) { /* The worker reports I/O failure. */ } stream = null; }
    }
  }
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  // Owned by the main thread. A cancelled worker keeps the slot until it exits.
  private Transfer active;
  private boolean destroyed;

  private Transfer begin(PluginCall call, boolean exporting) {
    if (destroyed || getActivity() == null || getActivity().isFinishing()) { call.reject("Saved passwords are unavailable", "unavailable"); return null; }
    if (active != null) { call.reject("Finish the current password transfer first", "busy"); return null; }
    try { active = new Transfer(call, PasswordVaultAccess.get(getContext()), exporting); return active; }
    catch (Exception unavailable) { call.reject("Saved passwords are unavailable", "unavailable"); return null; }
  }
  private boolean current(Transfer op) { return active == op && !op.cancelled && !op.settled && !destroyed; }
  private void release(Transfer op) {
    if (op.workers == 0 && op.settled) {
      if (op.parsed != null) { op.parsed.wipe(); op.parsed = null; }
      if (active == op) active = null;
    }
  }
  private void finish(Transfer op, JSObject result, String message, String code) {
    main.post(() -> {
      if (op.settled) return;
      op.settled = true;
      op.access.lock(op.ticket);
      if (op.dialog != null) { op.dialog.setOnDismissListener(null); op.dialog.dismiss(); op.dialog = null; }
      if (op.cancelled) op.call.reject(cancelMessage(op), "cancelled");
      else if (result == null) op.call.reject(message, code); else op.call.resolve(result);
      release(op);
    });
  }
  private void fail(Transfer op, Exception failure, String ioMessage, String ioCode) {
    if (failure instanceof PasswordVaultAccess.Locked) finish(op, null, "Unlock expired; start the transfer again", "locked");
    else if (failure instanceof PasswordVaultAccess.KeyInvalidated) finish(op, null, "Saved passwords can no longer be decrypted on this device", "key-invalidated");
    else finish(op, null, ioMessage, ioCode);
  }
  private void cancel(Transfer op) {
    if (op == null || op.settled) return;
    op.cancelled = true;
    op.cancellation.cancel();
    op.closeStream();
    op.access.lock(op.ticket);
    finish(op, null, cancelMessage(op), "cancelled");
  }
  private static String cancelMessage(Transfer op) {
    return op.exporting ? "Export stopped. The selected file may contain passwords; delete it if you do not need it."
      : "Import stopped. Check saved passwords before trying again.";
  }
  private void check(Transfer op) throws PasswordVaultAccess.Locked {
    if (op.cancelled || !op.access.unlocked(op.ticket)) throw new PasswordVaultAccess.Locked();
  }
  private void work(Transfer op, Runnable body) {
    if (!current(op)) return;
    op.phase = Phase.IO; op.workers++;
    io.execute(() -> {
      try { if (!op.cancelled) body.run(); }
      finally { op.closeStream(); main.post(() -> { op.workers--; release(op); }); }
    });
  }
  private void authenticate(Transfer op, Runnable next) {
    if (!current(op)) return;
    op.phase = Phase.AUTH;
    // The document picker can stop the host and revoke its old grant. The fresh
    // prompt therefore starts after the picker; its exact ticket admits all work.
    op.access.lock();
    SecretSurfaces.dismiss();
    PasswordUnlock.prompt(getActivity(), new PasswordUnlock.Result() {
      @Override public void unlocked(long ticket) {
        if (!current(op)) { op.access.lock(ticket); return; }
        op.ticket = ticket; next.run();
      }
      @Override public void failed(String code) { finish(op, null, "Unlock was cancelled or unavailable", code); }
    });
    if (current(op) && op.access.pending()) op.ticket = op.access.ticket();
  }
  private void picker(Transfer op, Intent intent, String callback) {
    if (!current(op)) return;
    op.phase = Phase.PICKER;
    try { startActivityForResult(op.call, intent, callback); }
    catch (RuntimeException unavailable) { finish(op, null, "No app can open the document picker", "unavailable"); }
  }
  private void returned(PluginCall call, ActivityResult result, java.util.function.BiConsumer<Transfer, Uri> next) {
    Transfer op = active;
    if (op == null || op.call != call || op.phase != Phase.PICKER || !current(op)) return;
    Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
    if (uri == null || !"content".equals(uri.getScheme())) { cancel(op); return; }
    authenticate(op, () -> next.accept(op, uri));
  }

  @PluginMethod public void exportVault(PluginCall call) {
    main.post(() -> {
      Transfer op = begin(call, true); if (op == null) return;
      op.dialog = new AlertDialog.Builder(getActivity()).setTitle("Export saved passwords?")
        .setMessage("This exports all saved passwords to a file that is NOT encrypted. Anyone who can open it can read every password.\n\nSave it only somewhere you trust, and delete it when you are done. Unlock saved passwords after choosing the file.")
        .setNegativeButton("Cancel", (dialog, which) -> cancel(op))
        .setOnCancelListener(dialog -> cancel(op))
        .setPositiveButton("Export", (dialog, which) -> picker(op,
          new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/csv").putExtra(Intent.EXTRA_TITLE, "passwords.csv"), "exportDocument"))
        .show();
      op.dialog.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
    });
  }
  @ActivityCallback private void exportDocument(PluginCall call, ActivityResult result) {
    returned(call, result, (op, target) -> work(op, () -> {
      byte[] bytes = null;
      try {
        List<PasswordCsv.Entry> rows = op.access.use(op.ticket, store -> {
          check(op);
          List<PasswordCsv.Entry> out = new ArrayList<>();
          JSONArray entries = store.entries();
          for (int i = 0; i < entries.length(); i++) {
            JSONObject summary = entries.getJSONObject(i), record = store.get(summary.getString("id"));
            out.add(new PasswordCsv.Entry(summary.getString("label"), summary.getString("username"), PasswordVaultStore.bindings(record), record.getString("password")));
          }
          return out;
        });
        int count = 0; for (PasswordCsv.Entry entry : rows) count += entry.facets.size();
        if (count == 0) { finish(op, null, "There are no saved passwords to export", "empty"); return; }
        bytes = PasswordCsv.export(rows); rows.clear(); check(op);
        try (AssetFileDescriptor descriptor = getContext().getContentResolver().openAssetFileDescriptor(target, "wt", op.cancellation)) {
          if (descriptor == null) throw new java.io.IOException();
          try (OutputStream out = descriptor.createOutputStream()) {
            op.attach(out);
            for (int offset = 0; offset < bytes.length; offset += 16384) { check(op); out.write(bytes, offset, Math.min(16384, bytes.length - offset)); }
            out.flush(); check(op);
          }
        }
        JSObject done = new JSObject(); done.put("exported", count); finish(op, done, null, null);
      } catch (Exception failure) {
        fail(op, failure, "Export did not complete. The selected file may contain passwords; delete it if you do not need it.", "write-failed");
      } finally { if (bytes != null) java.util.Arrays.fill(bytes, (byte) 0); }
    }));
  }

  @PluginMethod public void importVault(PluginCall call) {
    main.post(() -> {
      Transfer op = begin(call, false); if (op == null) return;
      picker(op, new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        .putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"text/csv", "text/comma-separated-values", "text/plain", "application/vnd.ms-excel"}), "importDocument");
    });
  }
  @ActivityCallback private void importDocument(PluginCall call, ActivityResult result) {
    returned(call, result, (op, source) -> work(op, () -> {
      byte[] bytes = null, chunk = new byte[65536];
      try {
        check(op);
        try (AssetFileDescriptor descriptor = getContext().getContentResolver().openAssetFileDescriptor(source, "r", op.cancellation)) {
          if (descriptor == null) throw new java.io.IOException();
          try (InputStream in = descriptor.createInputStream(); WipingBuffer buffer = new WipingBuffer()) {
            op.attach(in); int count;
            while ((count = in.read(chunk)) != -1) { check(op); if (buffer.size() + count > PasswordCsv.MAX_BYTES) throw new SizeLimit(); buffer.write(chunk, 0, count); }
            bytes = buffer.toByteArray();
          }
        }
        Set<String> existing = op.access.use(op.ticket, store -> {
          check(op);
          Set<String> keys = new HashSet<>(); JSONArray entries = store.entries();
          for (int i = 0; i < entries.length(); i++) { JSONObject entry = entries.getJSONObject(i); for (String facet : PasswordVaultStore.bindings(entry)) if (PasswordFacets.isWeb(facet)) keys.add(facet + "\n" + entry.getString("username")); }
          return keys;
        });
        PasswordCsv.Import parsed;
        try { parsed = PasswordCsv.parse(bytes, existing); }
        catch (java.io.IOException invalid) { finish(op, null, safeImportMessage(invalid.getMessage()), "invalid"); return; }
        main.post(() -> review(op, parsed));
      } catch (SizeLimit large) { finish(op, null, "The file is larger than 2 MB", "invalid"); }
      catch (Exception failure) { fail(op, failure, "The file could not be read", "read-failed"); }
      finally { java.util.Arrays.fill(chunk, (byte) 0); if (bytes != null) java.util.Arrays.fill(bytes, (byte) 0); }
    }));
  }
  private static final class WipingBuffer extends ByteArrayOutputStream {
    @Override public void close() { java.util.Arrays.fill(buf, (byte) 0); reset(); }
  }
  private static final class SizeLimit extends Exception { SizeLimit() { super(null, null, false, false); } }
  private static String safeImportMessage(String message) {
    List<String> known = java.util.Arrays.asList("The file is empty", "The file is larger than 2 MB", "The file is not UTF-8 text", "The file is not valid CSV", "The file has too many rows", "The file has no url and password columns");
    return known.contains(message) ? message : "The file could not be read";
  }
  private void review(Transfer op, PasswordCsv.Import parsed) {
    if (!current(op) || !op.access.unlocked(op.ticket)) { parsed.wipe(); if (current(op)) finish(op, null, "Unlock expired; import the file again", "locked"); return; }
    op.parsed = parsed; op.phase = Phase.REVIEW;
    boolean empty = parsed.importable().isEmpty();
    op.dialog = new AlertDialog.Builder(getActivity()).setTitle(empty ? "Nothing to import" : "Import passwords?")
      .setMessage(PasswordCsv.review(parsed) + "\n\nThe file itself is not encrypted. Delete it after importing.")
      .setNegativeButton("Cancel", (dialog, which) -> cancel(op))
      .setOnCancelListener(dialog -> cancel(op))
      .setPositiveButton(empty ? "Close" : "Import", (dialog, which) -> {
        if (empty) { JSObject none = new JSObject(); none.put("imported", 0); none.put("skipped", parsed.skipped()); finish(op, none, null, null); }
        else work(op, () -> {
          try {
            int saved = op.access.use(op.ticket, store -> {
              check(op); JSONArray incoming = new JSONArray();
              for (PasswordCsv.Row row : parsed.importable()) incoming.put(new JSONObject().put("label", row.label).put("username", row.username).put("origin", row.origin).put("password", row.password()));
              return store.addWebsiteEntries(incoming);
            });
            JSObject done = new JSObject(); done.put("imported", saved); done.put("skipped", parsed.rows.size() - saved); finish(op, done, null, null);
          } catch (Exception failure) { fail(op, failure, "Import could not be confirmed. Check saved passwords before trying again.", "write-failed"); }
          finally { parsed.wipe(); }
        });
      }).show();
    op.dialog.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
  }
  @Override protected void handleOnStop() {
    Transfer op = active;
    // Picker and device-credential Activities are expected foreground handoffs.
    if (op != null && op.phase != Phase.PICKER && !(op.phase == Phase.AUTH && op.access.pending())) cancel(op);
    super.handleOnStop();
  }
  @Override protected void handleOnDestroy() {
    destroyed = true; cancel(active); io.shutdown(); super.handleOnDestroy();
  }
}
