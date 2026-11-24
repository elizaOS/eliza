// spec/os/build/runtimePayload.md, "The agent spawns only when every inventory digest matches on the device"; spec/os/build/runtimePayload.md, "A damaged extracted file is extracted again once before the start fails"
package ai.eliza.os.agent;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public final class PayloadStart {
  private PayloadStart() {}

  public static void main(String[] args) throws IOException {
    if (args.length != 5) throw new IllegalArgumentException("Expected the APK assets, the native library directory, the runtime directory, a version code and an ABI");
    Path assets = Path.of(args[0]);
    PayloadCheck.Check check = PayloadCheck.prepare(name -> Files.newInputStream(assets.resolve(name)), Long.parseLong(args[3]), List.of(args[4]),
      Path.of(args[1]), Path.of(args[2]), directory -> {});
    if (check instanceof PayloadCheck.Failed failed) for (String error : failed.errors()) System.out.println(error);
  }
}
