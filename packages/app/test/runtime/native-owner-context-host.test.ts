import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("actual native callback and secure-store dispatch deny foreign or invented context", () => {
  const root = resolve(import.meta.dirname, "../../../.."),
    temporary = mkdtempSync(join(tmpdir(), "native-owner-host-"));
  const java =
      process.env.JAVA_HOME ||
      "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
    jar = process.env.ELIZA_JSON_JAR;
  if (!jar)
    throw Error("Set pinned ELIZA_JSON_JAR for actual native callback test");
  const native = join(
    root,
    "packages/app/platforms/android/app/src/main/java/ai/elizaos/app",
  );
  const source = readFileSync(join(native, "AgentSecureStore.java"), "utf8"),
    start = source.indexOf("    private JSONObject execute("),
    end = source.indexOf("\n    @Override public void close()", start);
  expect(start).toBeGreaterThan(0);
  const execute = source.slice(start, end);
  try {
    const processSource = join(temporary, "Process.java"),
      dispatch = join(temporary, "NativeOwnerDispatchTest.java");
    writeFileSync(
      processSource,
      `package android.os;public final class Process {public static int myUid(){return 10001;}}`,
    );
    writeFileSync(
      dispatch,
      `package ai.elizaos.app;import java.io.*;import java.nio.charset.*;import java.security.*;import java.util.*;import javax.crypto.*;import javax.crypto.spec.*;import android.os.Process;import android.util.AtomicFile;import org.json.*;
public class NativeOwnerDispatchTest {private static final int MAX_FRAME=4*1024*1024;private final File directory=new File(".");int secretCalls;private javax.crypto.SecretKey key(){secretCalls++;throw new AssertionError("Native context touched credential storage");}
${execute}
interface Task{void run()throws Exception;}static void denied(Task t)throws Exception{try{t.run();}catch(SecurityException e){return;}throw new AssertionError("Expected denial");}
public static void main(String[] args)throws Exception {NativeOwnerDispatchTest host=new NativeOwnerDispatchTest();JSONObject request=new JSONObject().put("id","owned-request").put("operation","nativeOwnerContext");try{host.execute(request,10001);throw new AssertionError("Absent callback admitted");}catch(UnsupportedOperationException expected){}int[] calls={0};NativeSourceHost.configureOwnerReminderContext(()->{calls[0]++;return NativeOwnerContextTest.context();});denied(()->host.execute(request,10002));if(calls[0]!=0)throw new AssertionError("Foreign peer reached callback");denied(()->host.execute(new JSONObject(request.toString()).put("vaultId","invented"),10001));denied(()->host.execute(new JSONObject(request.toString()).put("accountRef","invented"),10001));JSONObject result=host.execute(request,10001);if(!result.getBoolean("ok")||!"native-owner".equals(result.getJSONObject("context").getString("subjectUserId"))||host.secretCalls!=0||calls[0]!=1)throw new AssertionError("Wrong native dispatch");System.out.println("PASS actual secure-store closed native dispatch");}}
`,
    );
    const android = join(
      homedir(),
      "Library/Android/sdk/platforms/android-36/android.jar",
    );
    execFileSync(join(java, "bin/javac"), [
      "--release",
      "17",
      "-cp",
      jar + ":" + android,
      "-d",
      temporary,
      processSource,
      dispatch,
      join(native, "NativeSourceHost.java"),
      join(
        root,
        "packages/app/test/fixtures/native-source/NativeOwnerContextTest.java",
      ),
    ]);
    for (const name of ["NativeOwnerContextTest", "NativeOwnerDispatchTest"]) {
      const output = execFileSync(
        join(java, "bin/java"),
        [
          "-cp",
          temporary + ":" + jar + ":" + android,
          "ai.elizaos.app." + name,
        ],
        { encoding: "utf8" },
      );
      expect(output).toMatch(/^PASS /);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
