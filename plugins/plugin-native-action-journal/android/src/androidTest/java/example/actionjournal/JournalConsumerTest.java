package example.actionjournal;

import static org.junit.Assert.*;
import ai.eliza.plugins.actionjournal.*;
import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Test;

/** Uses Android Keystore and durable encrypted files. No device action is dispatched. */
public class JournalConsumerTest {
 private static final String SCOPE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
 private static final String HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
 private ActionJournal journal(File root) {
  JsonCredentialSlots slots = new JsonCredentialSlots(root, "example.actionjournal.test", slot -> 262144);
  return new ActionJournal(ActionJournalConfiguration.standard("example:v1"), new ActionJournal.Storage() {
   public String read(String slot) throws Exception { return slots.read(slot); }
   public void write(String slot, String value) throws Exception { slots.write(slot, value); }
  }, ActionJournal.BOUNDED_RESULTS);
 }
 @Test public void durableReplayAndRecovery() throws Exception {
  File root = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getNoBackupFilesDir(), "journal");
  JSONObject record = new JSONObject().put("operation", "fixture-only-private-marker");
  ActionJournal first = journal(root);
  assertTrue(first.reserve(SCOPE, "proposal", "operation", HASH, record).created);
  first.markApplying(SCOPE, "proposal", "attempt");
  // Recreate all Java owners. The phase comes from encrypted files, not a retained object.
  ActionJournal reopened = journal(root);
  assertFalse(reopened.reserve(SCOPE, "proposal", "operation", HASH, record).created);
  assertEquals("applying", reopened.get(SCOPE, "proposal").getString("phase"));
  try { reopened.markApplying(SCOPE, "proposal", "second-attempt"); fail("Repeated dispatch admitted"); }
  catch (ActionJournal.Refused expected) { }
  try { reopened.reserve(SCOPE, "proposal", "different-operation", HASH, record); fail("Changed operation admitted"); }
  catch (ActionJournal.Refused expected) { }
  try { reopened.update(SCOPE, "proposal", entry -> entry.put("phase", "reserved")); fail("Recovery rewound dispatch"); }
  catch (ActionJournal.Refused expected) { }
  assertEquals("applying", journal(root).get(SCOPE, "proposal").getString("phase"));
  reopened.finish(SCOPE, "proposal", "unknown", "No action was dispatched by this fixture", null);
  assertEquals("unknown", journal(root).get(SCOPE, "proposal").getString("status"));
  assertEquals(1, journal(root).list(SCOPE).length());
  for (File file : root.listFiles())
   assertFalse(new String(Files.readAllBytes(file.toPath()), StandardCharsets.ISO_8859_1).contains("fixture-only-private-marker"));
  // A durable index write followed by a failed entry write is recoverable without an effect.
  JsonCredentialSlots slots = new JsonCredentialSlots(root, "example.actionjournal.test", slot -> 262144);
  ActionJournal interrupted = new ActionJournal(ActionJournalConfiguration.standard("example:v1"), new ActionJournal.Storage() {
   public String read(String slot) throws Exception { return slots.read(slot); }
   public void write(String slot, String value) throws Exception {
    if (slot.endsWith(":entry:interrupted")) throw new IOException("Fixture interruption before entry commit");
    slots.write(slot, value);
   }
  }, ActionJournal.BOUNDED_RESULTS);
  try { interrupted.reserve(SCOPE, "interrupted", "operation2", HASH, record); fail("Write failure hidden"); }
  catch (IOException expected) { }
  assertEquals(1, journal(root).list(SCOPE).length());
  assertTrue(journal(root).reserve(SCOPE, "interrupted", "operation2", HASH, record).created);
  assertEquals(2, journal(root).list(SCOPE).length());
 }
}
