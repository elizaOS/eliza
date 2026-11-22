// spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/health.md, "Absence needs two refused connects in a row and the dead journaled child of this launch"
package ai.eliza.os.agent;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Paths;
import java.util.OptionalLong;

final class AndroidChildProcesses implements ChildJournal.Processes {
  @Override public OptionalLong startTime(int pid) throws IOException {
    String stat;
    try { stat = new String(Files.readAllBytes(Paths.get("/proc", Integer.toString(pid), "stat")), StandardCharsets.US_ASCII); }
    catch (NoSuchFileException gone) { return OptionalLong.empty(); }
    int end = stat.lastIndexOf(')');
    String[] fields = end < 0 ? new String[0] : stat.substring(end + 2).trim().split(" ");
    if (fields.length < 20 || !fields[19].matches("[0-9]+")) throw new IOException("Unreadable /proc/" + pid + "/stat");
    return fields[0].equals("Z") || fields[0].equals("X") ? OptionalLong.empty() : OptionalLong.of(Long.parseLong(fields[19]));
  }

  @Override public void kill(int pid) throws IOException {
    try { Os.kill(pid, OsConstants.SIGKILL); }
    catch (ErrnoException error) {
      if (error.errno != OsConstants.ESRCH) throw new IOException("Cannot end agent child " + pid, error);
    }
  }
}
