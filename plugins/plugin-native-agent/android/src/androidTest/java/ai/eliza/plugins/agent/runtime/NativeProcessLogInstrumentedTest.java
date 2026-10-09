package ai.eliza.plugins.agent.runtime;

import static org.junit.Assert.*;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.junit.Test;

/** Real Android file-channel, permissions and stream behavior; no production logs. */
public final class NativeProcessLogInstrumentedTest {
  private static String repeat(char value, int count) {
    char[] chars = new char[count]; Arrays.fill(chars, value); return new String(chars);
  }
  @Test public void privateBoundedRedactedRecordsAndNoFollow() throws Exception {
    File root = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(), "process-log-" + System.nanoTime());
    assertTrue(root.mkdir());
    Path log = new File(root, "child.log").toPath(), victim = new File(root, "victim").toPath(), link = new File(root, "link").toPath();
    try {
      String secret = "fixture-" + repeat('q', 5000);
      NativeProcessLog sink = new NativeProcessLog(log, 128, 32);
      sink.drain(new ByteArrayInputStream((repeat('x', 29) + secret + " suffix\n").getBytes(StandardCharsets.UTF_8)), Arrays.asList(secret));
      String redacted = new String(Files.readAllBytes(log), StandardCharsets.UTF_8);
      assertFalse(redacted.contains("fixture")); assertTrue(redacted.endsWith(" [truncated]\n"));
      assertTrue(Files.size(log) <= 128);
      assertEquals(0600, android.system.Os.stat(log.toString()).st_mode & 0777);
      sink.drain(new ByteArrayInputStream((repeat('界', 100) + "\n").getBytes(StandardCharsets.UTF_8)), Collections.emptyList());
      assertTrue(Files.size(log) <= 128);
      assertTrue(new String(Files.readAllBytes(log), StandardCharsets.UTF_8).startsWith("界"));
      Files.write(victim, "untouched".getBytes(StandardCharsets.UTF_8)); Files.createSymbolicLink(link, victim);
      try { new NativeProcessLog(link, 128, 32).drain(new ByteArrayInputStream(new byte[]{'x','\n'}), Collections.emptyList()); fail("symlink accepted"); }
      catch (IOException expected) { }
      assertEquals("untouched", new String(Files.readAllBytes(victim), StandardCharsets.UTF_8));
    } finally { Files.deleteIfExists(log); Files.deleteIfExists(link); Files.deleteIfExists(victim); assertTrue(root.delete()); }
  }
}
