package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.EmbeddedRuntimeLaunch;
import java.nio.file.*;
import java.util.*;

public final class EmbeddedRuntimeLaunchTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("check " + checks); }
  public static void main(String[] args) throws Exception {
    Path root = Path.of(args[0]); Files.createDirectories(root);
    Path installed = Files.createDirectory(root.resolve("installed"));
    for (String file : new String[]{"libeliza_bun.so","libeliza_ld_musl_aarch64.so","libeliza_stdcpp.so","libeliza_gcc_s.so","libeliza_canvas.so"}) Files.writeString(installed.resolve(file), "fixture");
    Path state = Files.createDirectory(root.resolve("state")), bundle = Files.createDirectory(root.resolve("bundle"));
    EmbeddedRuntimeLaunch launch = new EmbeddedRuntimeLaunch(bundle, installed, root.resolve("aliases"), state,"example.host",root.toString());
    String token = EmbeddedRuntimeLaunch.token(); check(token.matches("[A-Za-z0-9_-]{64}")); check(!token.equals(EmbeddedRuntimeLaunch.token()));
    int port = EmbeddedRuntimeLaunch.loopbackPort(); check(port > 0 && port <= 65535);
    ProcessBuilder agent = launch.agent(bundle.resolve("agent.js"), state.resolve("config.json"),port,token,
      Map.of("ELIZA_API_BIND","0.0.0.0","ELIZA_API_TOKEN","wrong","HOME","wrong","PROVIDER_KEY","synthetic","ELIZA_PROVIDER","chosen"));
    check(agent.command().equals(List.of(installed.resolve("libeliza_ld_musl_aarch64.so").toString(),installed.resolve("libeliza_bun.so").toString(),"--no-env-file","--no-install",bundle.resolve("agent.js").toString(),"serve")));
    check(agent.directory().equals(bundle.toFile())); check(agent.environment().get("ELIZA_API_BIND").equals("127.0.0.1"));
    check(agent.environment().get("ELIZA_API_TOKEN").equals(token)); check(agent.environment().get("HOME").equals(state.toString()));
    check(agent.environment().get("ELIZA_PROVIDER").equals("chosen")); check(!agent.environment().containsKey("USER"));
    ProcessBuilder gateway = launch.gateway(bundle.resolve("gateway.js"));
    check(!gateway.environment().containsKey("PROVIDER_KEY")); check(!gateway.environment().containsKey("ELIZA_API_TOKEN"));
    check(gateway.environment().get("NAPI_RS_NATIVE_LIBRARY_PATH").equals(installed.resolve("libeliza_canvas.so").toString()));
    check(Files.isSymbolicLink(root.resolve("aliases/libstdc++.so.6")));
    check(EmbeddedRuntimeLaunch.fingerprint("abc").equals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    try { launch.agent(bundle.resolve("agent.js"),state.resolve("config"),0,token,Map.of()); throw new AssertionError(); } catch (IllegalArgumentException expected) { checks++; }
    try { launch.agent(bundle.resolve("agent.js"),state.resolve("config"),port,"line\nbreak",Map.of()); throw new AssertionError(); } catch (IllegalArgumentException expected) { checks++; }
    // Real child observes only its selected environment, without loading fixture binaries.
    check(gateway.environment().get("LD_LIBRARY_PATH").equals(root.resolve("aliases")+":"+installed));
    gateway.command(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",System.getProperty("java.class.path"),Child.class.getName());
    // The host JVM needs its host libraries, not the placeholder Android .so files.
    gateway.environment().remove("LD_LIBRARY_PATH");
    gateway.redirectErrorStream(true); Process child=gateway.start();
    String output=new String(child.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
    if(child.waitFor()!=0)throw new AssertionError("Host JVM probe failed: "+output);
    check(output.equals(state.toString()));
    Files.delete(state.resolve("tmp")); Files.createSymbolicLink(state.resolve("tmp"), bundle);
    try { new EmbeddedRuntimeLaunch(bundle,installed,root.resolve("aliases"),state,"example.host",root.toString()); throw new AssertionError(); } catch (java.io.IOException expected) { checks++; }
    System.out.println("EmbeddedRuntimeLaunch: " + checks + " checks passed");
  }
  public static final class Child {
    public static void main(String[] args) {
      if(System.getenv("PROVIDER_KEY")!=null||System.getenv("ELIZA_API_TOKEN")!=null)throw new AssertionError("Agent authority leaked");
      System.out.print(System.getenv("HOME"));
    }
  }
}
