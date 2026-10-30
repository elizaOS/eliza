import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Execute the actual plugin and extracted service/lifecycle methods. Only Android,
// Capacitor, process launch and socket I/O ports are replaced. Not device evidence.
const root = path.resolve(import.meta.dirname, "../../../..");
const app = "packages/app/platforms/android/app/src/main/java/ai/elizaos/app/";
const connection =
  "plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/connection/";
function source(file) {
  return process.env.ELIZA_NATIVE_OWNER_BASELINE
    ? execFileSync(
        "git",
        ["show", `${process.env.ELIZA_NATIVE_OWNER_BASELINE}:${file}`],
        { cwd: root, encoding: "utf8" },
      )
    : fs.readFileSync(path.join(root, file), "utf8");
}
function method(text, start) {
  const at = text.indexOf(start);
  if (at < 0) throw Error(`Missing production method ${start}`);
  let depth = 0;
  for (let i = text.indexOf("{", at); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  throw Error(`Unclosed production method ${start}`);
}

test("actual canonical native dispatch fences aliases, held stops and Activity replacement", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-owner-dispatch-"),
  );
  try {
    const cache = path.join(
      os.homedir(),
      ".gradle/caches/modules-2/files-2.1/org.json/json/20250517",
    );
    const jar =
      process.env.ELIZA_JSON_JAR ??
      fs.readdirSync(cache).flatMap((entry) =>
        fs
          .readdirSync(path.join(cache, entry))
          .filter((name) => name.endsWith(".jar"))
          .map((name) => path.join(cache, entry, name)),
      )[0];
    assert.ok(
      jar,
      "org.json 20250517 must be available in Gradle cache or ELIZA_JSON_JAR",
    );
    const files = [];
    function write(name, value) {
      const file = path.join(directory, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
      files.push(file);
    }
    const ports = JSON.parse(
      fs.readFileSync(
        new URL("../android/native-owner-dispatch/ports.json", import.meta.url),
        "utf8",
      ),
    );
    for (const [name, value] of Object.entries(ports)) write(name, value);
    for (const name of ["AgentPlugin", "ElizaResidentCredentials"]) {
      let value = source(`${app}${name}.java`);
      if (name === "ElizaResidentCredentials") {
        value = `package ai.elizaos.app; import ai.eliza.plugins.securestore.nativeonly.*; class ElizaResidentCredentials {static final String TOKEN_KEY="session.steward_token";${value.slice(value.indexOf("    private static final Object LIFECYCLE"), value.indexOf("    static <T> T mutateToken"))}}`;
      }
      write(`ai/elizaos/app/${name}.java`, value);
    }
    for (const name of [
      "NativeOwnerTransport",
      "NativeAppReadPolicy",
      ...(source(`${app}AgentPlugin.java`).includes("NativeAppRequestPolicy")
        ? ["NativeAppRequestPolicy"]
        : []),
      "OwnerRoutePolicy",
    ])
      write(
        `ai/eliza/plugins/agent/connection/${name}.java`,
        source(`${connection}${name}.java`),
      );
    write(
      "ai/eliza/plugins/securestore/nativeonly/CredentialIntentFence.java",
      source(
        "plugins/plugin-native-secure-store/android/src/main/java/ai/eliza/plugins/securestore/nativeonly/CredentialIntentFence.java",
      ),
    );
    const service = source(`${app}ElizaAgentService.java`);
    const methods = [
      "    public static void stop(Context context)",
      "    public static void restart(Context context)",
      "    public static String requestLocalAgent(String requestJson)",
      "    private static final class LocalAgentRequest",
      "    private static LocalAgentRequest parseLocalAgentRequest(",
      "    private static JSONObject buildRequestPayload(",
      "    private static boolean isSafeLocalAgentPath(",
      "    private static JSONObject filterForwardedHeaders(",
      "    private static boolean hasHeader(",
      "    private static boolean isBlockedForwardedHeader(",
    ].map((start) => method(service, start));
    const admission = service.slice(
      service.indexOf("    private static long ownerRequestEpoch;"),
      service.indexOf(
        "    private static final String CREDENTIAL_SHUTDOWN_EPOCH",
      ),
    );
    const sequenceStart = service.indexOf(
      "                        long ownerRequestEpoch = beginRuntimeStart();",
    );
    const sequencedStart =
      sequenceStart < 0
        ? "startAgentProcess(true);"
        : service
            .slice(
              sequenceStart,
              service.indexOf("\n                    }", sequenceStart),
            )
            .replace("!restartFirst", "true");
    write(
      "ai/elizaos/app/ElizaAgentService.java",
      `package ai.elizaos.app;
import android.content.*;import org.json.*;import java.io.*;import java.util.*;import java.nio.charset.StandardCharsets;
public class ElizaAgentService {
${admission}
static final String ACTION_STOP="stop",ACTION_RESTART="restart"; static final int LOCAL_REQUEST_DEFAULT_TIMEOUT_MS=1000,LOCAL_INFERENCE_REQUEST_TIMEOUT_MS=1000,LOCAL_REQUEST_MAX_TIMEOUT_MS=10000,LOCAL_REQUEST_MAX_BODY_BYTES=1000000;
static volatile String currentLocalAgentToken="root";static volatile java.util.function.Function<JSONObject,JSONObject> exchange;static volatile Runnable launch=()->{};boolean shuttingDown;
public static String localAgentToken(){return currentLocalAgentToken;}public static String localAgentToken(Context context){return currentLocalAgentToken;}public static JSONObject getLocalAgentBootState(Context context){return new JSONObject().put("state","running");}
public static void start(Context context){context.startService(new Intent(context,ElizaAgentService.class));}
static boolean isLongRunningInferencePath(String path){return false;}static JSONObject dispatchBufferedOverSocket(JSONObject payload,int timeout){return exchange.apply(payload);}
static boolean launchAccepted=true;boolean startAgentProcess(boolean allowAdoption){launch.run();return launchAccepted;}void finishStart(){${sequencedStart}}
public static class LocalStreamHandle {public void cancel(){}} public static void requestLocalAgentStream(String value,java.util.function.Consumer<String> receive){exchange.apply(new JSONObject(value));}public static void subscribeLocalAgentEvents(String value,java.util.function.Consumer<String> receive,LocalStreamHandle handle){}
${methods.join("\n")}}
`,
    );
    write(
      "ai/elizaos/app/NativeOwnerDispatchTest.java",
      fs.readFileSync(
        new URL(
          "../android/native-owner-dispatch/NativeOwnerDispatchTest.java",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const java = (name) =>
      process.env.JAVA_HOME
        ? path.join(process.env.JAVA_HOME, "bin", name)
        : name;
    execFileSync(
      java("javac"),
      ["--release", "17", "-cp", jar, "-d", directory, ...files],
      { timeout: 20000 },
    );
    const result = execFileSync(
      java("java"),
      [
        "-cp",
        `${directory}${path.delimiter}${jar}`,
        "ai.elizaos.app.NativeOwnerDispatchTest",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    console.log(result.trim());
    assert.match(result, /PASS canonical native owner dispatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
