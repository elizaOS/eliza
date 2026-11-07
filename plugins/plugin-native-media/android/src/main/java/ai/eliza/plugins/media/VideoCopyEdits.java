package ai.eliza.plugins.media;

import android.content.ContentProviderOperation;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.provider.MediaStore;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import androidx.annotation.OptIn;
import androidx.media3.common.Effect;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.ExperimentalApi;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.Crop;
import androidx.media3.effect.Presentation;
import androidx.media3.effect.ScaleAndRotateTransformation;
import androidx.media3.transformer.AudioEncoderSettings;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.Transformer;
import androidx.media3.transformer.VideoEncoderSettings;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/**
 * Native edit-as-copy over an admitted video: trim, quarter-turn rotation and centered crop with
 * Media3, saved as a new owned MP4 under the host's configured video-edit placement. The encoder
 * reads a frozen private snapshot; publication rechecks source bytes, access and provider revision.
 * Each Save has one durable identity, including after a lost bridge response, and a crash between
 * publish and receipt resolves to saved or failed, never a duplicate. The host's {@link Sources}
 * admits each source (identity, access, revision); the editor never accepts a renderer URI.
 * Journal and private storage names derive from the host's {@link OwnedMediaConfig} namespace.
 */
@OptIn(markerClass = {UnstableApi.class, ExperimentalApi.class})
public final class VideoCopyEdits {
  public interface Sources {
    Source read(String id, String expectedRevision) throws Exception;
    /**
     * Rechecks after opening (export readback, publish): identity, access and revision, but not
     * window focus. A notification shade or system dialog takes focus without pausing the editor;
     * leaving Photos is already covered by the pause/epoch cancel.
     */
    default Source recheck(String id, String expectedRevision) throws Exception {
      return read(id, expectedRevision);
    }
  }
  public static final class Source {
    public final Uri uri;
    public final String revision;
    public Source(Uri uri, String revision) {
      this.uri = uri;
      this.revision = revision;
    }
  }
  private static final Uri OUTPUTS = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
  private final Context context;
  private final OwnedMediaConfig config;
  private final Sources sources;
  private final BooleanSupplier foreground;
  private final SharedPreferences journal;
  private final File directory;
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private final java.util.concurrent.atomic.AtomicLong epoch =
      new java.util.concurrent.atomic.AtomicLong();
  private volatile Session active;
  private volatile boolean retired;
  private volatile HandlerThread encoderThread;
  private volatile Handler encoder;
  private static final class Session {
    String token, id, revision;
    Source source;
    byte[] digest;
    File input, output;
    long durationMs, bitrate;
    long epoch;
    int width, height;
    boolean audio;
    ContentValues version;
    VideoEditSpec edit;
    volatile String stage = "prepared";
    volatile boolean cancelled, encodingFinished;
    volatile Transformer transformer;
    volatile PluginCall saveCall;
  }

  public VideoCopyEdits(Context context, OwnedMediaConfig config, Sources sources)
      throws IOException {
    this(context, config, sources, () -> false);
  }
  /** {@code foreground}: whether the host's editing surface is the focused foreground window. */
  public VideoCopyEdits(Context context, OwnedMediaConfig config, Sources sources,
      BooleanSupplier foreground) throws IOException {
    if (config == null || config.videoEditRelativePath == null)
      throw new IllegalArgumentException("Configure video edits");
    this.context = context.getApplicationContext();
    this.config = config;
    this.sources = sources;
    this.foreground = foreground;
    // Host-namespaced names keep an installed host's receipts and pending inputs readable.
    journal = context.getSharedPreferences(
        config.preferences("video-copy-results-v1"), Context.MODE_PRIVATE);
    directory = new File(context.getCacheDir(), config.privateName("video-edits"));
    if (directory.exists() && !directory.isDirectory())
      throw new IOException("Video edit storage is unavailable");
    if (!directory.getCanonicalFile().getParentFile().equals(
            context.getCacheDir().getCanonicalFile()))
      throw new IOException("Video edit storage changed");
  }
  public static boolean isVideoOperation(String token) {
    return token != null && token.startsWith("video-");
  }
  private static void token(String token) {
    if (token == null || !token.matches("video-[a-f0-9-]{36}")
        || !UUID.fromString(token.substring(6)).toString().equals(token.substring(6)))
      throw new IllegalArgumentException("Invalid video copy request");
  }
  private File file(String token, String suffix) throws IOException {
    token(token);
    File result = new File(directory, token + suffix);
    if (!result.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile()))
      throw new IOException("Video edit storage changed");
    return result;
  }
  private String name(String token) {
    token(token);
    return config.videoEditName(token.substring(6));
  }
  private void write(String token, JSONObject record) throws IOException {
    if (!journal.edit().putString(token, record.toString()).commit())
      throw new IOException("Video copy receipt could not be retained");
  }
  private JSONObject read(String token) throws Exception {
    token(token);
    String raw = journal.getString(token, null);
    return raw == null ? null : new JSONObject(raw);
  }
  private JSObject receipt(String token, String status, String id) {
    JSObject value = new JSObject();
    value.put("operationId", token);
    value.put("status", status);
    if (id != null)
      value.put("id", "v:" + id);
    return value;
  }
  // Native-only forensic custody. Never called by result/reconcile or a JS bridge.
  private static final long PRESERVATION_MAX_BYTES = 4L * 1024 * 1024;
  private static final String PRESERVATION_ROOT = "video-copy-preservation-v1";
  private static String hex(byte[] value) {
    StringBuilder out = new StringBuilder(value.length * 2);
    for (byte b : value) {
      out.append(Character.forDigit((b >>> 4) & 15, 16));
      out.append(Character.forDigit(b & 15, 16));
    }
    return out.toString();
  }
  private static String textHash(String value) throws Exception {
    return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
  }
  private String requirePreservationState(String token, String expected, long admittedEpoch)
      throws Exception {
    if (Build.VERSION.SDK_INT < 30 || retired || epoch.get() != admittedEpoch || active != null
        || !foreground.getAsBoolean())
      throw new IOException("Video copy review is not idle and foreground");
    String raw = journal.getString(token, null);
    if (raw == null || raw.length() > 16384 || !textHash(raw).equals(expected)
        || !new JSONObject(raw).optString("status").equals("failed"))
      throw new IOException("Reviewed failed-copy record changed");
    return raw;
  }
  @SuppressWarnings("deprecation")
  private JSONObject preservationMetadata(Uri uri, String token) throws Exception {
    String[] columns = {"_id", "volume_name", "_display_name", "_data", "relative_path",
        "mime_type", "_size", "owner_package_name", "is_pending", "is_trashed", "date_added",
        "date_modified", "date_expires", "generation_added", "generation_modified", "duration",
        "width", "height"};
    try (Cursor row = context.getContentResolver().query(MediaStore.setIncludePending(uri), columns,
             "owner_package_name=? AND _display_name=? AND is_pending=1 AND is_trashed=0",
             new String[] {context.getPackageName(), name(token)}, null)) {
      if (row == null || !row.moveToFirst())
        throw new IOException("Owned pending output is unavailable");
      JSONObject result = new JSONObject();
      for (int i = 0; i < columns.length; i++) {
        switch (row.getType(i)) {
          case Cursor.FIELD_TYPE_NULL:
            result.put(columns[i], JSONObject.NULL);
            break;
          case Cursor.FIELD_TYPE_INTEGER:
            result.put(columns[i], row.getLong(i));
            break;
          case Cursor.FIELD_TYPE_STRING:
            result.put(columns[i], row.getString(i));
            break;
          default:
            throw new IOException("Unexpected pending metadata type");
        }
      }
      if (row.moveToNext())
        throw new IOException("Pending output is ambiguous");
      return result;
    }
  }
  private void requirePrivateDirectory(File directory) throws Exception {
    File anchor = context.getFilesDir().getCanonicalFile(), current = directory.getAbsoluteFile();
    while (!current.equals(anchor)) {
      if (current.getParentFile() == null || !current.toPath().startsWith(anchor.toPath()))
        throw new IOException("Recovery directory escaped private storage");
      StructStat stat = Os.lstat(current.getAbsolutePath());
      if (!OsConstants.S_ISDIR(stat.st_mode) || stat.st_uid != android.os.Process.myUid()
          || (stat.st_mode & 077) != 0 || !current.getCanonicalFile().equals(current))
        throw new IOException("Recovery directory is unsafe");
      current = current.getParentFile();
    }
  }
  private File newPreservationDirectory(String token) throws Exception {
    File anchor = context.getFilesDir().getCanonicalFile(),
         root = new File(anchor, PRESERVATION_ROOT);
    try {
      Os.mkdir(root.getAbsolutePath(), 0700);
    } catch (ErrnoException exists) {
      if (exists.errno != OsConstants.EEXIST)
        throw exists;
    }
    requirePrivateDirectory(root);
    File directory = new File(root, token);
    Os.mkdir(directory.getAbsolutePath(), 0700);
    requirePrivateDirectory(directory);
    return directory;
  }
  private FileOutputStream preservationOutput(File directory, String name) throws Exception {
    requirePrivateDirectory(directory);
    if (name.equals(".") || name.equals("..") || !new File(name).getName().equals(name)
        || name.contains("/") || name.contains("\\"))
      throw new IOException("Invalid recovery artifact name");
    File file = new File(directory, name);
    java.io.FileDescriptor fd = Os.open(file.getAbsolutePath(),
        OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW,
        0600);
    try {
      StructStat stat = Os.fstat(fd);
      if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_uid != android.os.Process.myUid()
          || (stat.st_mode & 077) != 0 || stat.st_nlink != 1)
        throw new IOException("Recovery artifact is unsafe");
      return new FileOutputStream(fd);
    } catch (Exception failure) {
      Os.close(fd);
      throw failure;
    }
  }
  private void preservationFile(File directory, String name, String value) throws Exception {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    if (bytes.length > 65536)
      throw new IOException("Recovery metadata exceeds its limit");
    try (FileOutputStream output = preservationOutput(directory, name)) {
      output.write(bytes);
      output.flush();
      output.getFD().sync();
    }
  }
  private void syncPreservationDirectory(File directory) throws Exception {
    requirePrivateDirectory(directory);
    String path = directory.getAbsolutePath();
    StructStat before = Os.lstat(path);
    java.io.FileDescriptor fd =
        Os.open(path, OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_NONBLOCK, 0);
    try {
      StructStat opened = Os.fstat(fd);
      if (!OsConstants.S_ISDIR(opened.st_mode) || opened.st_uid != android.os.Process.myUid()
          || (opened.st_mode & 077) != 0 || opened.st_dev != before.st_dev
          || opened.st_ino != before.st_ino)
        throw new IOException("Recovery directory changed before sync");
      Os.fsync(fd);
      requirePrivateDirectory(directory);
      StructStat after = Os.lstat(path);
      if (after.st_dev != opened.st_dev || after.st_ino != opened.st_ino)
        throw new IOException("Recovery directory changed during sync");
    } finally {
      Os.close(fd);
    }
  }
  private byte[] preservationManifestReadback(File directory, String name, StructStat expected)
      throws Exception {
    requirePrivateDirectory(directory);
    if (!name.equals("COMPLETION.pending") && !name.equals("COMPLETE.json"))
      throw new IOException("Invalid recovery manifest");
    String path = new File(directory, name).getAbsolutePath();
    java.io.FileDescriptor fd =
        Os.open(path, OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_NONBLOCK, 0);
    try {
      StructStat opened = Os.fstat(fd);
      if (!OsConstants.S_ISREG(opened.st_mode) || opened.st_uid != android.os.Process.myUid()
          || (opened.st_mode & 077) != 0 || opened.st_nlink != 1 || opened.st_dev != expected.st_dev
          || opened.st_ino != expected.st_ino || opened.st_size != expected.st_size
          || opened.st_size > 65536)
        throw new IOException("Recovery manifest changed");
    } catch (Exception failure) {
      Os.close(fd);
      throw failure;
    }
    byte[] value;
    try (FileInputStream input = new FileInputStream(fd);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
      byte[] chunk = new byte[8192];
      int length;
      while ((length = input.read(chunk)) != -1) {
        if (bytes.size() + length > 65536)
          throw new IOException("Recovery manifest exceeds its limit");
        bytes.write(chunk, 0, length);
      }
      value = bytes.toByteArray();
      StructStat after = Os.fstat(fd);
      if (after.st_dev != expected.st_dev || after.st_ino != expected.st_ino
          || after.st_uid != android.os.Process.myUid() || (after.st_mode & 077) != 0
          || !OsConstants.S_ISREG(after.st_mode) || after.st_nlink != 1
          || after.st_size != value.length || after.st_size != expected.st_size)
        throw new IOException("Recovery manifest changed during readback");
    }
    requirePrivateDirectory(directory);
    StructStat current = Os.lstat(path);
    if (current.st_dev != expected.st_dev || current.st_ino != expected.st_ino
        || current.st_uid != android.os.Process.myUid() || !OsConstants.S_ISREG(current.st_mode)
        || (current.st_mode & 077) != 0 || current.st_nlink != 1 || current.st_size != value.length)
      throw new IOException("Recovery manifest path changed");
    return value;
  }
  private JSONObject preservationDigest(InputStream input, FileOutputStream output, String token,
      String recordHash, long admittedEpoch) throws Exception {
    if (input == null)
      throw new IOException("Pending output could not be opened");
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    byte[] chunk = new byte[64 * 1024];
    long bytes = 0;
    int emptyReads = 0;
    while (true) {
      requirePreservationState(token, recordHash, admittedEpoch);
      int length = input.read(chunk);
      if (length < 0)
        break;
      if (length == 0) {
        if (++emptyReads > 4)
          throw new IOException("Pending output read stalled");
        continue;
      }
      emptyReads = 0;
      bytes += length;
      if (bytes > PRESERVATION_MAX_BYTES)
        throw new IOException("Pending output exceeds reviewed recovery limit");
      hash.update(chunk, 0, length);
      if (output != null)
        output.write(chunk, 0, length);
    }
    return new JSONObject().put("bytes", bytes).put("sha256", hex(hash.digest()));
  }
  /** Only native callers on this actual editor instance; no URI/path or permission authority. */
  public void preserveClosedFailure(String token, String expectedRecordHash, PluginCall call) {
    long admittedEpoch = epoch.get();
    submit(call, () -> {
      File archive = null;
      String stage = "admission";
      try {
        token(token);
        if (expectedRecordHash == null || !expectedRecordHash.matches("[a-f0-9]{64}"))
          throw new IOException("Invalid reviewed record hash");
        String original = requirePreservationState(token, expectedRecordHash, admittedEpoch);
        JSONObject record = new JSONObject(original);
        Uri source = copy(token, record);
        if (source == null)
          throw new IOException("Owned pending output is unavailable");
        JSONObject before = preservationMetadata(source, token);
        String volume = before.getString("volume_name");
        if (!MediaStore.getExternalVolumeNames(context).contains(volume))
          throw new IOException("Pending output volume is unavailable");
        source = ContentUris.withAppendedId(
            MediaStore.Video.Media.getContentUri(volume), before.getLong("_id"));
        requirePreservationState(token, expectedRecordHash, admittedEpoch);
        archive = newPreservationDirectory(token);
        preservationFile(archive, "ATTEMPT.json",
            new JSONObject()
                .put("operationId", token)
                .put("recordSHA256", expectedRecordHash)
                .put("maxBytes", PRESERVATION_MAX_BYTES)
                .put("createdAt", System.currentTimeMillis())
                .toString());
        preservationFile(archive, "journal-original.json", original);
        preservationFile(archive, "metadata-before.json", before.toString());
        syncPreservationDirectory(archive);
        stage = "source-copy";
        JSONObject first;
        try (FileOutputStream output = preservationOutput(archive, "bytes.bin");
            InputStream input = context.getContentResolver().openInputStream(source)) {
          first = preservationDigest(input, output, token, expectedRecordHash, admittedEpoch);
          output.flush();
          output.getFD().sync();
        }
        stage = "escrow-readback";
        requirePrivateDirectory(archive);
        JSONObject escrow;
        java.io.FileDescriptor fd = Os.open(new File(archive, "bytes.bin").getAbsolutePath(),
            OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
        try {
          StructStat stat = Os.fstat(fd);
          if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_uid != android.os.Process.myUid()
              || (stat.st_mode & 077) != 0 || stat.st_nlink != 1)
            throw new IOException("Recovery artifact changed");
        } catch (Exception failure) {
          Os.close(fd);
          throw failure;
        }
        try (InputStream input = new FileInputStream(fd)) {
          escrow = preservationDigest(input, null, token, expectedRecordHash, admittedEpoch);
        }
        stage = "source-second-read";
        JSONObject second;
        try (InputStream input = context.getContentResolver().openInputStream(source)) {
          second = preservationDigest(input, null, token, expectedRecordHash, admittedEpoch);
        }
        stage = "stable-readback";
        requirePreservationState(token, expectedRecordHash, admittedEpoch);
        Uri foundAfter = copy(token, record);
        if (foundAfter == null)
          throw new IOException("Pending output disappeared");
        JSONObject after = preservationMetadata(foundAfter, token);
        requirePreservationState(token, expectedRecordHash, admittedEpoch);
        if (!first.toString().equals(escrow.toString())
            || !first.toString().equals(second.toString())
            || !before.toString().equals(after.toString()))
          throw new IOException("Pending output changed during preservation");
        preservationFile(archive, "metadata-after.json", after.toString());
        requirePreservationState(token, expectedRecordHash, admittedEpoch);
        JSONObject complete = new JSONObject()
                                  .put("operationId", token)
                                  .put("status", "preserved")
                                  .put("recordSHA256", expectedRecordHash)
                                  .put("sourceURI", source.toString())
                                  .put("sourceBefore", before)
                                  .put("sourceAfter", after)
                                  .put("bytes", first.getLong("bytes"))
                                  .put("sha256", first.getString("sha256"))
                                  .put("forensicOnly", true);
        // Android app policy forbids hard links. Completion is exclusive and
        // durable, not an atomic whole-file publication; a filename is never proof.
        stage = "seal";
        preservationFile(archive, "COMPLETION.pending", complete.toString());
        syncPreservationDirectory(archive);
        requirePreservationState(token, expectedRecordHash, admittedEpoch);
        Uri finalFound = copy(token, record);
        if (finalFound == null
            || !after.toString().equals(preservationMetadata(finalFound, token).toString()))
          throw new IOException("Pending output changed before preservation seal");
        requirePrivateDirectory(archive);
        String sealedPath = new File(archive, "COMPLETION.pending").getAbsolutePath(),
               completePath = new File(archive, "COMPLETE.json").getAbsolutePath();
        StructStat sealed = Os.lstat(sealedPath);
        if (!OsConstants.S_ISREG(sealed.st_mode) || sealed.st_uid != android.os.Process.myUid()
            || (sealed.st_mode & 077) != 0 || sealed.st_nlink != 1)
          throw new IOException("Preservation seal changed");
        byte[] manifestBytes = complete.toString().getBytes(StandardCharsets.UTF_8);
        if (!java.util.Arrays.equals(
                manifestBytes, preservationManifestReadback(archive, "COMPLETION.pending", sealed)))
          throw new IOException("Preservation seal content changed");
        stage = "complete";
        requirePreservationState(token, expectedRecordHash, admittedEpoch);
        preservationFile(archive, "COMPLETE.json", complete.toString());
        StructStat published = Os.lstat(completePath);
        if (!OsConstants.S_ISREG(published.st_mode) || published.st_uid != sealed.st_uid
            || published.st_mode != sealed.st_mode || published.st_ino == sealed.st_ino
            || published.st_dev != sealed.st_dev || published.st_nlink != 1
            || published.st_size != sealed.st_size)
          throw new IOException("Preservation seal changed");
        syncPreservationDirectory(archive);
        if (!java.util.Arrays.equals(
                manifestBytes, preservationManifestReadback(archive, "COMPLETE.json", published)))
          throw new IOException("Complete recovery manifest changed");
        JSObject result = new JSObject();
        result.put("operationId", token);
        result.put("artifactId", token);
        result.put("status", "preserved");
        result.put("bytes", first.getLong("bytes"));
        result.put("sha256", first.getString("sha256"));
        requirePreservationState(token, expectedRecordHash, admittedEpoch);
        call.resolve(result);
      } catch (Exception failure) {
        if (archive != null)
          try {
            JSONObject incomplete = new JSONObject()
                                        .put("operationId", token)
                                        .put("stage", stage)
                                        .put("errorClass", failure.getClass().getSimpleName())
                                        .put("sourceWritesPerformed", false)
                                        .put("journalWritesPerformed", false);
            if (failure instanceof ErrnoException)
              incomplete.put("errno", ((ErrnoException) failure).errno);
            preservationFile(archive, "INCOMPLETE.json", incomplete.toString());
            syncPreservationDirectory(archive);
          } catch (Exception retained) { /* Keep existing evidence; never overwrite or clean up. */
          }
        call.reject(
            "Video copy preservation refused: " + stage + "/" + failure.getClass().getSimpleName());
      }
    });
  }
  private boolean terminal(String status) {
    return status.equals("saved") || status.equals("failed") || status.equals("not-started");
  }
  private interface Work {
    void run() throws Exception;
  }
  private void submit(PluginCall call, Work work) {
    if (retired) {
      call.reject("Video editor closed");
      return;
    }
    dispatch(() -> {
      try {
        work.run();
      } catch (Exception error) {
        call.reject(
            error.getMessage() == null ? "Video edit could not be confirmed" : error.getMessage());
      }
    }, () -> call.reject("Video editor closed"));
  }
  // Callbacks can arrive after Activity teardown has stopped IO. Preserve the
  // durable request for recovery and answer the bridge instead of crashing.
  private void dispatch(Runnable work, Runnable refused) {
    try {
      io.execute(work);
    } catch (java.util.concurrent.RejectedExecutionException stopped) {
      refused.run();
    }
  }
  private void finish(Session session, Exception failure) {
    dispatch(() -> complete(session, failure), () -> {
      synchronized (session) {
        session.cancelled = true;
        if (active == session)
          active = null;
      }
      if (session.saveCall != null)
        session.saveCall.reject("Video copy outcome is unresolved. Reopen Photos to check this "
                                + "request before saving another copy.");
      retire();
    });
  }
  private ContentValues version(Uri uri) throws Exception {
    String[] columns = Build.VERSION.SDK_INT >= 30
        ? new String[] {"_size", "date_modified", "generation_modified", "is_pending", "is_trashed"}
        : new String[] {"_size", "date_modified", "is_pending"};
    try (Cursor row = context.getContentResolver().query(uri, columns, null, null, null)) {
      if (row == null || !row.moveToFirst() || row.getLong(0) <= 0
          || row.getLong(0) > VideoEditSpec.MAX_BYTES
          || row.getInt(2 + (Build.VERSION.SDK_INT >= 30 ? 1 : 0)) != 0
          || (Build.VERSION.SDK_INT >= 30 && row.getInt(4) != 0))
        throw new IOException("Choose an available video up to 100 MB");
      ContentValues values = new ContentValues();
      for (int i = 0; i < columns.length; i++) values.put(columns[i], row.getLong(i));
      return values;
    }
  }
  private byte[] bytes(Session session, File destination) throws Exception {
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    try (InputStream input = context.getContentResolver().openInputStream(session.source.uri);
        FileOutputStream output = destination == null ? null : new FileOutputStream(destination)) {
      if (input == null)
        throw new IOException("Video is unavailable");
      byte[] buffer = new byte[64 * 1024];
      long total = 0;
      int length;
      while ((length = input.read(buffer)) != -1) {
        if (session.cancelled || retired || session.epoch != epoch.get())
          throw new IOException("Video editor closed");
        total += length;
        if (total > VideoEditSpec.MAX_BYTES)
          throw new IOException("Choose a video up to 100 MB");
        hash.update(buffer, 0, length);
        if (output != null)
          output.write(buffer, 0, length);
      }
      if (total != session.version.getAsLong("_size"))
        throw new IOException("Video changed while opening");
      if (output != null) {
        output.flush();
        output.getFD().sync();
      }
      return hash.digest();
    }
  }
  private void current(Session session, boolean digest) throws Exception {
    if (active != session || session.cancelled || retired || session.epoch != epoch.get())
      throw new IOException("Video editor closed");
    Source source = sources.recheck(session.id, session.revision);
    if (!source.uri.equals(session.source.uri) || !source.revision.equals(session.revision)
        || !version(source.uri).equals(session.version)
        || digest && !Arrays.equals(session.digest, bytes(session, null)))
      throw new IOException("Video changed. Close and reopen the editor.");
  }
  private void metadata(Session session) throws Exception {
    try (MediaMetadataRetriever media = new MediaMetadataRetriever()) {
      media.setDataSource(session.input.getAbsolutePath());
      session.durationMs =
          Long.parseLong(media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
      session.width =
          Integer.parseInt(media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
      session.height =
          Integer.parseInt(media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
      String angle = media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
      int rotation = angle == null ? 0 : Integer.parseInt(angle);
      if (rotation % 90 != 0)
        throw new IOException("This video's orientation is unsupported");
      if (Math.floorMod(rotation, 180) != 0) {
        int width = session.width;
        session.width = session.height;
        session.height = width;
      }
      session.audio =
          "yes".equals(media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO));
      session.bitrate = Math.max(256_000,
          Math.min(12_000_000,
              session.input.length() * 8_000 / Math.max(1, session.durationMs)
                  - (session.audio ? 128_000 : 0)));
      new VideoEditSpec(0, session.durationMs / 1000d, 0, false, session.durationMs, session.width,
          session.height);
    }
  }
  private void remove(File file) throws IOException {
    if (file.exists() && !file.delete())
      throw new IOException("Video edit cleanup could not be confirmed");
  }
  private void files(String token) throws IOException {
    remove(file(token, "-input.mp4"));
    remove(file(token, "-output.mp4"));
  }
  @SuppressWarnings("deprecation")
  // API29-compatible pending visibility; never infer absence from the default collection.
  private Uri copy(String token, JSONObject record) throws Exception {
    Uri found = null;
    try (Cursor row = context.getContentResolver().query(MediaStore.setIncludePending(OUTPUTS),
             new String[] {"_id"}, "owner_package_name=? AND _display_name=?",
             new String[] {context.getPackageName(), name(token)}, null)) {
      if (row == null)
        throw new IOException("Video copy lookup is unavailable");
      if (row.moveToFirst()) {
        found = ContentUris.withAppendedId(OUTPUTS, row.getLong(0));
        if (row.moveToNext())
          throw new IOException("More than one copy matches this request. Inspect Photos.");
      }
    }
    if (record.has("pendingId")
        && (found == null
            || !record.getString("pendingId").equals(Long.toString(ContentUris.parseId(found)))))
      throw new IOException("Recorded video copy needs recovery review");
    return found;
  }
  @SuppressWarnings("deprecation")
  private boolean pending(Uri uri) throws Exception {
    try (Cursor row = context.getContentResolver().query(
             MediaStore.setIncludePending(uri), new String[] {"is_pending"}, null, null, null)) {
      if (row == null || !row.moveToFirst())
        throw new IOException("Video copy readback is unavailable");
      return row.getInt(0) == 1;
    }
  }
  private JSObject reconcile(String token) throws Exception {
    JSONObject record = read(token);
    if (record == null)
      return receipt(token, "not-started", null);
    if (active != null && active.token.equals(token) && active.saveCall != null)
      return receipt(token, "incomplete", null);
    if (record.optString("status").equals("saved")) {
      try {
        files(token);
      } catch (IOException cleanup) { /* The confirmed published copy remains saved; retainSpace
                                         retries owned-cache cleanup. */
      }
      return receipt(token, "saved", record.getString("id"));
    }
    if (active != null && active.token.equals(token)) {
      active.cancelled = true;
      active = null;
    }
    Uri found = copy(token, record);
    if (found != null && !pending(found)) {
      String id = Long.toString(ContentUris.parseId(found));
      record.put("status", "saved").put("id", id)
      ;
      write(token, record);
      files(token);
      return receipt(token, "saved", id);
    }
    if (found != null
        && (record.has("failureStage") || record.optString("status").equals("failed")))
      throw new IOException("Pending video copy needs recovery review");
    if (found != null
        && context.getContentResolver().delete(found, "is_pending=1 AND owner_package_name=?",
               new String[] {context.getPackageName()})
            != 1)
      throw new IOException("Pending video cleanup could not be confirmed");
    files(token);
    String status = record.optString("binding").isEmpty() ? "not-started" : "failed";
    record.remove("pendingId")
    ;
    record.put("status", status)
    ;
    write(token, record);
    return receipt(token, status, null);
  }
  private void retainSpace() throws Exception {
    if (directory.getUsableSpace() < VideoEditSpec.MAX_BYTES * 4)
      throw new IOException("Free at least 400 MB to edit a video");
    for (String key : journal.getAll().keySet()) {
      JSONObject record = read(key);
      if (terminal(record.optString("status"))) {
        if (record.optString("status").equals("failed")) {
          Uri retained = copy(key, record);
          if (retained != null && pending(retained))
            throw new IOException("Pending video copy needs recovery review");
        }
        files(key);
      }
    }
    if (journal.getAll().size() < 128)
      return;
    List<String> terminal = new ArrayList<>();
    for (String key : journal.getAll().keySet()) {
      JSONObject row = read(key);
      if (terminal(row.optString("status")))
        terminal.add(key);
    }
    terminal.sort((a, b) -> {
      try {
        return Long.compare(read(a).optLong("createdAt"), read(b).optLong("createdAt"));
      } catch (Exception invalid) {
        throw new IllegalStateException("Video copy history needs recovery", invalid);
      }
    });
    if (terminal.isEmpty() || !journal.edit().remove(terminal.get(0)).commit())
      throw new IOException("Resolve earlier video copies before editing another");
  }
  public void begin(String id, String expected, PluginCall call) {
    long admittedEpoch = epoch.get();
    submit(call, () -> {
      if (retired || admittedEpoch != epoch.get())
        throw new IOException("Video editor closed");
      if (active != null)
        throw new IOException("Close the current video editor first");
      if (!directory.isDirectory() && !directory.mkdirs())
        throw new IOException("Video edit storage is unavailable");
      for (String key : journal.getAll().keySet()) {
        JSONObject row = read(key);
        if (!terminal(row.optString("status")))
          reconcile(key);
      }
      retainSpace();
      Session session = new Session();
      session.epoch = admittedEpoch;
      session.token = "video-" + UUID.randomUUID();
      session.id = id;
      session.revision = expected;
      session.source = sources.read(id, expected);
      session.version = version(session.source.uri);
      session.input = file(session.token, "-input.mp4");
      session.output = file(session.token, "-output.mp4");
      JSONObject record =
          new JSONObject().put("status", "prepared").put("createdAt", System.currentTimeMillis());
      write(session.token, record);
      active = session;
      try {
        if (!session.input.createNewFile())
          throw new IOException("Video edit storage changed");
        session.digest = bytes(session, session.input);
        metadata(session);
        current(session, true);
        record.put("durationMs", session.durationMs)
            .put("width", session.width)
            .put("height", session.height)
        ;
        write(session.token, record);
        JSObject value = new JSObject();
        value.put("sessionId", session.token);
        value.put("operationId", session.token);
        value.put("duration", session.durationMs / 1000d);
        value.put("width", session.width);
        value.put("height", session.height);
        call.resolve(value);
      } catch (Exception failure) {
        active = null;
        reconcile(session.token);
        throw failure;
      }
    });
  }
  private Handler encoder() {
    if (encoder == null) {
      encoderThread = new HandlerThread("Video copy");
      encoderThread.start();
      encoder = new Handler(encoderThread.getLooper());
    }
    return encoder;
  }
  public void save(
      String token, double start, double end, int rotation, boolean crop, PluginCall call) {
    submit(call, () -> {
      JSONObject record = read(token);
      if (record == null)
        throw new IOException("Reopen the video editor");
      VideoEditSpec edit = new VideoEditSpec(start, end, rotation, crop,
          record.getLong("durationMs"), record.getInt("width"), record.getInt("height"));
      if (record.has("binding")) {
        if (!record.getString("binding").equals(edit.binding()))
          throw new IOException("This copy request already has different edits");
        call.resolve(reconcile(token));
        return;
      }
      Session session = active;
      if (session == null || !session.token.equals(token))
        throw new IOException("Video editor closed");
      current(session, true);
      if (edit.unchanged(session.durationMs)) {
        session.cancelled = true;
        active = null;
        files(token);
        record.put("status", "not-started")
        ;
        write(token, record);
        call.resolve(receipt(token, "unchanged", null));
        return;
      }
      if (session.output.exists())
        throw new IOException("Video edit output already exists");
      record.put("binding", edit.binding()).put("status", "exporting")
      ;
      write(token, record);
      session.edit = edit;
      session.saveCall = call;
      encoder().post(() -> encode(session));
    });
  }
  private void encode(Session session) {
    try {
      if (session.cancelled || retired)
        throw new IOException("Video editor closed");
      List<Effect> effects = new ArrayList<>();
      if (session.edit.crop)
        effects.add(new Crop(-1 / 1.3f, 1 / 1.3f, -1 / 1.3f, 1 / 1.3f));
      if (session.edit.rotation != 0)
        effects.add(new ScaleAndRotateTransformation.Builder()
                .setRotationDegrees(-session.edit.rotation)
                .build());
      effects.add(Presentation.createForWidthAndHeight(
          session.edit.width, session.edit.height, Presentation.LAYOUT_SCALE_TO_FIT));
      MediaItem media = new MediaItem.Builder()
                            .setUri(Uri.fromFile(session.input))
                            .setClippingConfiguration(new MediaItem.ClippingConfiguration.Builder()
                                    .setStartPositionMs(session.edit.startMs)
                                    .setEndPositionMs(session.edit.endMs)
                                    .build())
                            .build();
      EditedMediaItem edited =
          new EditedMediaItem.Builder(media)
              .setRemoveAudio(false)
              .setEffects(new Effects(java.util.Collections.emptyList(), effects))
              .build();
      int bitrate = (int) Math.max(256_000,
          Math.min(12_000_000,
              session.bitrate * (long) session.edit.width * session.edit.height
                  / ((long) session.width * session.height)));
      // Non-default encoder settings force real sample encoding, including trim-only
      // edits. No MP4 edit list can expose trimmed-away video/audio in another player.
      DefaultEncoderFactory factory =
          new DefaultEncoderFactory.Builder(context)
              .setEnableFormatFallback(false)
              .setRequestedVideoEncoderSettings(
                  new VideoEncoderSettings.Builder().setBitrate(bitrate).build())
              .setRequestedAudioEncoderSettings(
                  new AudioEncoderSettings.Builder().setBitrate(128_000).build())
              .build();
      session.transformer =
          new Transformer.Builder(context)
              .setLooper(encoder.getLooper())
              .setEncoderFactory(factory)
              .setVideoMimeType(MimeTypes.VIDEO_H264)
              .setAudioMimeType(MimeTypes.AUDIO_AAC)
              .experimentalSetMp4EditListTrimEnabled(false)
              .experimentalSetTrimOptimizationEnabled(false)
              .addListener(new Transformer.Listener() {
                @Override
                public void onCompleted(Composition composition, ExportResult result) {
                  session.encodingFinished = true;
                  finish(session, null);
                }
                @Override
                public void onError(
                    Composition composition, ExportResult result, ExportException error) {
                  session.encodingFinished = true;
                  finish(session, error);
                }
              })
              .build();
      session.stage = "encoding";
      session.transformer.start(edited, session.output.getAbsolutePath());
      long deadline = android.os.SystemClock.elapsedRealtime()
          + Math.max(60_000, (session.edit.endMs - session.edit.startMs) * 3);
      Runnable guard = new Runnable() {
        public void run() {
          if (session.encodingFinished)
            return;
          if (session.cancelled || retired || session.output.length() > VideoEditSpec.MAX_BYTES
              || android.os.SystemClock.elapsedRealtime() > deadline) {
            session.cancelled = true;
            session.transformer.cancel();
            session.encodingFinished = true;
            finish(session, new IOException("Video export stopped. Original unchanged."));
          } else
            encoder.postDelayed(this, 250);
        }
      };
      encoder.postDelayed(guard, 250);
    } catch (Exception failure) {
      session.encodingFinished = true;
      finish(session, failure);
    }
  }
  private void output(Session session) throws Exception {
    if (!session.output.isFile() || session.output.length() <= 0
        || session.output.length() > VideoEditSpec.MAX_BYTES)
      throw new IOException("Video copy is empty or exceeds 100 MB");
    try (MediaMetadataRetriever media = new MediaMetadataRetriever()) {
      media.setDataSource(session.output.getAbsolutePath());
      long duration =
          Long.parseLong(media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
      int width = Integer.parseInt(
              media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)),
          height = Integer.parseInt(
              media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
      String angle = media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
      if (angle != null && Math.floorMod(Integer.parseInt(angle), 180) != 0) {
        int old = width;
        width = height;
        height = old;
      }
      if (width != session.edit.width || height != session.edit.height || duration <= 0
          || Math.abs(duration - (session.edit.endMs - session.edit.startMs)) > 150
          || session.audio
              != "yes".equals(
                  media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO)))
        throw new IOException("Video copy readback did not match the edit");
    }
  }
  private byte[] outputDigest(InputStream input, long expected, Session session) throws Exception {
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    byte[] buffer = new byte[64 * 1024];
    long bytes = 0;
    int length;
    while ((length = input.read(buffer)) != -1) {
      if (session.cancelled || retired)
        throw new IOException("Video editor closed");
      bytes += length;
      if (bytes > VideoEditSpec.MAX_BYTES)
        throw new IOException("Video copy exceeds 100 MB");
      hash.update(buffer, 0, length);
    }
    if (bytes != expected)
      throw new IOException("Video copy bytes did not match the export");
    return hash.digest();
  }
  private void complete(Session session, Exception failure) {
    if (active != session)
      return;
    try {
      if (failure != null)
        throw failure;
      session.stage = "export-readback";
      current(session, false);
      output(session);
      ContentValues values = new ContentValues();
      values.put("_display_name", name(session.token));
      values.put("mime_type", "video/mp4");
      values.put("relative_path", config.videoEditRelativePath);
      values.put("is_pending", 1);
      values.put("width", session.edit.width);
      values.put("height", session.edit.height);
      session.stage = "pending-insert";
      Uri target = context.getContentResolver().insert(OUTPUTS, values);
      if (target == null)
        throw new IOException("Video copy could not be created");
      session.stage = "pending-custody";
      JSONObject custody = read(session.token);
      custody.put("pendingId", Long.toString(ContentUris.parseId(target)));
      write(session.token, custody);
      session.stage = "pending-open";
      try (android.os.ParcelFileDescriptor descriptor =
               context.getContentResolver().openFileDescriptor(target, "w");
          FileInputStream input = new FileInputStream(session.output)) {
        if (descriptor == null)
          throw new IOException("Video copy could not be written");
        try (FileOutputStream out =
                 new android.os.ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
          byte[] chunk = new byte[64 * 1024];
          int length;
          while ((length = input.read(chunk)) != -1) {
            if (session.cancelled || retired)
              throw new IOException("Video editor closed");
            session.stage = "pending-write";
            out.write(chunk, 0, length);
          }
          session.stage = "pending-flush";
          out.flush();
          session.stage = "pending-fsync";
          out.getFD().sync();
          session.stage = "pending-close";
        }
      }
      session.stage = "pending-readback";
      try (InputStream saved = context.getContentResolver().openInputStream(target);
          FileInputStream exported = new FileInputStream(session.output)) {
        if (saved == null
            || !Arrays.equals(outputDigest(saved, session.output.length(), session),
                outputDigest(exported, session.output.length(), session)))
          throw new IOException("Video copy readback changed");
      }
      session.stage = "source-recheck";
      current(session, true);
      ArrayList<ContentProviderOperation> batch = new ArrayList<>();
      batch.add(ContentProviderOperation.newAssertQuery(session.source.uri)
              .withValues(session.version)
              .withExpectedCount(1)
              .build());
      batch.add(ContentProviderOperation.newUpdate(target)
              .withSelection(
                  "is_pending=1 AND owner_package_name=?", new String[] {context.getPackageName()})
              .withValue("is_pending", 0)
              .withExpectedCount(1)
              .build());
      session.stage = "publish";
      synchronized (session) {
        if (session.cancelled || retired || session.epoch != epoch.get())
          throw new IOException("Video editor closed");
        context.getContentResolver().applyBatch("media", batch);
      }
      session.stage = "publication-readback";
      if (pending(target))
        throw new IOException("Video publication could not be confirmed");
      session.stage = "receipt";
      JSONObject row = read(session.token);
      String id = Long.toString(ContentUris.parseId(target));
      row.put("status", "saved").put("id", id);
      write(session.token, row);
      files(session.token);
      active = null;
      session.saveCall.resolve(receipt(session.token, "saved", id));
    } catch (Exception error) {
      String errorClass = error.getClass().getSimpleName(),
             causeClass =
                 error.getCause() == null ? "none" : error.getCause().getClass().getSimpleName();
      android.util.Log.w("VideoCopyEdits",
          "stage=" + session.stage + ",class=" + errorClass + ",causeClass=" + causeClass + ",code="
              + (error instanceof ExportException ? ((ExportException) error).errorCode : 0));
      try {
        JSONObject failed = read(session.token);
        failed.put("failureStage", session.stage)
            .put("failureClass", errorClass)
            .put("failureCauseClass", causeClass);
        write(session.token, failed);
      } catch (Exception receiptFailure) {
        android.util.Log.w("VideoCopyEdits",
            "stage=failure-receipt,class=" + receiptFailure.getClass().getSimpleName());
      }
      active = null;
      try {
        session.saveCall.resolve(reconcile(session.token));
      } catch (Exception unknown) {
        session.saveCall.reject("Video copy outcome is unresolved. Reopen Photos to check this "
                                + "request before saving another copy.");
      }
    } finally {
      retire();
    }
  }
  public void result(String token, PluginCall call) {
    submit(call, () -> call.resolve(reconcile(token)));
  }
  public void cancel(String token) {
    Session session = active;
    if (token != null && (session == null || !session.token.equals(token)))
      return;
    // Also retire a Begin still queued on IO, before it can return a session ID.
    if (session == null) {
      epoch.incrementAndGet();
      return;
    }
    synchronized (session) {
      epoch.incrementAndGet();
      session.cancelled = true;
    }
    if (session.saveCall != null) {
      Handler handler = encoder;
      if (handler != null)
        handler.post(() -> {
          if (!session.encodingFinished) {
            if (session.transformer != null)
              session.transformer.cancel();
            session.encodingFinished = true;
            finish(session, new IOException("Video editor closed"));
          }
        });
    } else
      dispatch(
          ()
              -> {
            if (active == session) {
              active = null;
              try {
                reconcile(session.token);
              } catch (Exception unresolved) { /* The durable prepared record remains for read-only
                                                  recovery. */
              }
              retire();
            }
          },
          () -> {
            if (active == session)
              active = null;
            retire();
          });
  }
  private void retire() {
    if (retired && active == null) {
      if (encoderThread != null)
        encoderThread.quitSafely();
      io.shutdown();
    }
  }
  public void close() {
    if (retired)
      return;
    retired = true;
    cancel(null);
    if (active == null)
      retire();
  }
}
