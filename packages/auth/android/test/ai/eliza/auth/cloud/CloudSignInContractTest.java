package ai.eliza.auth.cloud;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Callback contract (test/fixtures/app-auth-callback-contract.json): every vector goes through
 * CloudSignInFlow.parseCallback. native-sign-in.test.mjs flattens the JSON into tab-separated lines
 * (no JSON library on this plain JVM): environment<TAB>expect<TAB>url<TAB>code<TAB>state<TAB>error.
 */
public final class CloudSignInContractTest {
 public static void main(String[] args) throws Exception {
  List<String> lines = Files.readAllLines(Path.of(args[0]));
  String callbackPath = args[1];
  CloudSignInEnvironment production = new CloudSignInEnvironment("production", "api.eliza.app", args[2], "elizacloud", "Eliza Cloud", callbackPath);
  CloudSignInEnvironment staging = new CloudSignInEnvironment("staging", "api-staging.eliza.app", args[3], "elizacloud-staging", "Eliza Cloud", callbackPath);
  int checks = 0;
  for (String line : lines) {
   String[] f = line.split("\t", -1);
   CloudSignInFlow.Callback parsed = CloudSignInFlow.parseCallback(f[2], "staging".equals(f[0]) ? staging : production);
   String actual = parsed == null ? "reject" : parsed.kind == CloudSignInFlow.ReturnKind.SUCCESS ? "success" : parsed.kind == CloudSignInFlow.ReturnKind.ERROR ? "error" : "return";
   if (!f[1].equals(actual)) throw new AssertionError("expected " + f[1] + ", got " + actual + ": " + f[2]);
   if ("success".equals(actual) && !(f[3].equals(parsed.code) && f[4].equals(parsed.state) && parsed.error == null)) throw new AssertionError("success values: " + f[2]);
   if ("error".equals(actual) && !(f[5].equals(parsed.error) && f[4].equals(parsed.state) && parsed.code == null)) throw new AssertionError("error values: " + f[2]);
   if ("return".equals(actual) && (parsed.code != null || parsed.state != null || parsed.error != null)) throw new AssertionError("a return carries nothing: " + f[2]);
   checks++;
  }
  System.out.println("PASS callback contract (" + checks + " vectors)");
 }
}
