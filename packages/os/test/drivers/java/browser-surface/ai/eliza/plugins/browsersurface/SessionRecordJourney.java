// spec/os/browser/tabHost/storage.md, "A saved session keeps the first valid row of each tab and address"; spec/os/browser/tabHost/storage.md, "A visit time is kept only for a kept history address, as a positive whole number of milliseconds"
package ai.eliza.plugins.browsersurface;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

public final class SessionRecordJourney {
  private SessionRecordJourney() {}

  public static void main(String[] args) throws Exception {
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    for (String line; (line = input.readLine()) != null;) {
      if (line.isBlank()) continue;
      output.println(BrowserSessionRecord.normalize(new JSONObject(line)));
    }
  }
}
