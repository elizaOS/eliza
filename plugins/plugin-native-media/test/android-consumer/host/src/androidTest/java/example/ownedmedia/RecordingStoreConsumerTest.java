package example.ownedmedia;

import static org.junit.Assert.*;

import ai.eliza.plugins.media.*;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Real Android file, AtomicFile and SharedPreferences execution of the recording store (with a
 * plain preferences file standing in for the host's encrypted slot store) and of the folder-tree
 * engine before any folder is chosen. Run only on an isolated test device.
 */
public final class RecordingStoreConsumerTest {
  private static final String OP = "00000000-0000-4000-8000-0000000000c1";

  @Test
  public void receiptsSurviveANewStoreAndPurgeErasesOnlyTheClip() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    SharedPreferences prefs = context.getSharedPreferences("recording-store-test", 0);
    prefs.edit().clear().commit();
    RecordingStore.Slots slots =
        new RecordingStore.Slots() {
          @Override
          public String read(String slot) {
            return prefs.getString(slot, null);
          }

          @Override
          public void write(String slot, String value) {
            prefs.edit().putString(slot, value).commit();
          }

          @Override
          public void remove(String slot) {
            prefs.edit().remove(slot).commit();
          }
        };
    File dir = new File(context.getNoBackupFilesDir(), "recording-store-test");
    File source = File.createTempFile("clip-", ".m4a", context.getCacheDir());
    Files.write(source.toPath(), new byte[64]);
    try {
      RecordingStore store = new RecordingStore(dir, "test-recording:v1:", "ownerId", slots);
      store.retain(source, "clip1", "owner1", 1000, "Synthetic");
      assertEquals("removed", store.remove("clip1", "owner1", OP, null).getString("status"));
      RecordingStore reopened = new RecordingStore(dir, "test-recording:v1:", "ownerId", slots);
      JSONObject status = reopened.deletionStatus("clip1", "owner1", OP);
      assertEquals("removed", status.getString("status"));
      assertEquals("purged", reopened.purge("clip1", "owner1", OP, null).getString("status"));
      assertFalse(reopened.audio("clip1").exists());
      assertEquals("", reopened.describe("clip1").getString("transcript"));
    } finally {
      source.delete();
      for (File file : dir.listFiles() == null ? new File[0] : dir.listFiles()) file.delete();
      dir.delete();
      prefs.edit().clear().commit();
    }
  }

  @Test
  public void anUnchosenFolderTreeAsksForAFolder() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    context.getSharedPreferences("folder-tree-test", 0).edit().clear().commit();
    DocumentFolderTree tree = new DocumentFolderTree(context, "folder-tree-test", uri -> "unused");
    JSObjectAssert.status(tree.guarded(() -> tree.list(null, null)), "unavailable");
    JSObjectAssert.status(tree.guarded(() -> tree.select("missing")), "revoked");
    assertEquals(
        android.content.Intent.ACTION_OPEN_DOCUMENT_TREE,
        DocumentFolderTree.pickerIntent().getAction());
  }

  private static final class JSObjectAssert {
    static void status(com.getcapacitor.JSObject value, String expected) {
      assertEquals(expected, value.getString("status"));
    }
  }
}
