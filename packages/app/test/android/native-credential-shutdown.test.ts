import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const native = join(
  root,
  "packages/app/platforms/android/app/src/main/java/ai/elizaos/app",
);
const source = readFileSync(join(native, "ElizaAgentService.java"), "utf8");
function method(text: string, start: string) {
  const at = text.indexOf(start);
  if (at < 0) throw Error(`Missing native method: ${start}`);
  let depth = 0;
  for (let i = text.indexOf("{", at); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(at, i + 1);
  }
  throw Error("Unclosed native method");
}
function java(name: string) {
  return process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", name)
    : name;
}
function runJava(name: string, text: string, extra: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "native-credential-stop-"));
  try {
    const file = join(directory, `${name}.java`);
    writeFileSync(file, text);
    execFileSync(
      java("javac"),
      ["--release", "17", "-d", directory, file, ...extra],
      { timeout: 20000 },
    );
    return execFileSync(java("java"), ["-cp", directory, name], {
      encoding: "utf8",
      timeout: 20000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("actual service credential shutdown confirms process exit and exact lifecycle request only", () => {
  const fields = source.slice(
    source.indexOf("    private static final String CREDENTIAL_SHUTDOWN_EPOCH"),
    source.indexOf(
      "    /**",
      source.indexOf(
        "    public static synchronized boolean isCredentialShutdownConfirmed",
      ),
    ),
  );
  const stopBranchStart = source.indexOf(
    "        if (ACTION_STOP.equals(action))",
  );
  const stopBranch = source.slice(
    stopBranchStart,
    source.indexOf(
      "        if (ACTION_RESTART.equals(action))",
      stopBranchStart,
    ),
  );
  const launchStart = source.indexOf(
    "    private void startAgentProcess(boolean allowAdoption)",
  );
  const launchPrefix = source.slice(
    launchStart,
    source.indexOf("            // Detached agents", launchStart),
  );
  const output = runJava(
    "ElizaAgentService",
    `import java.io.*;import java.util.*;import java.util.concurrent.*;
class BaseService {public void onDestroy(){}}
public class ElizaAgentService extends BaseService {
 static final String ACTION_STOP="stop",TAG="closed",NOTIFICATION_SERVICE="notification";static final int NOTIFICATION_ID=2,START_NOT_STICKY=2;static final long PROCESS_TERMINATE_GRACE_MS=10;
 static ElizaAgentService activeInstance;static int launches,deleted,timestamps,schedulerStops,signals,diagnostics;static volatile boolean interruptedObserved;static Runnable inventory=()->{};static Runnable onWait=()->{};
 final Object processLock=new Object();Process agentProcess;Thread stdoutPump,stderrPump,startWorker,watchdog;boolean detachedAgentMode,shuttingDown,foregroundStartDenied;long detachedLaunchStartedAtMs;String currentStatus="running";static String currentLocalAgentToken="protected-root",currentTerminalRunToken="protected-terminal";
 static class CloseablePort {void close(){}void stop(){}}CloseablePort chromiumBrowserConnection,agentSecureStore,bionicInferenceServer;
 static class Recovery {void close()throws IOException{throw new IOException("Unconfirmed IPC release");}}Recovery ipcRecovery;
 static class NotificationManager{void cancel(int id){}}Object getSystemService(String name){return new NotificationManager();}Object getApplicationContext(){return this;}
 static class Log{static void w(String tag,String message){}static void w(String tag,String message,Throwable e){interruptedObserved=Thread.currentThread().isInterrupted();}static void i(String tag,String message){}}
 static class ElizaWorkScheduler{static void runtimeStopped(Object context){schedulerStops++;}}
 static class IpcStartupRecovery {static boolean sole=true;static int checks;static void requireSoleUidProcess()throws Exception{checks++;if(!sole)throw new IOException("Other/unreadable same-UID process");}}
 static class Context {static final String NOTIFICATION_SERVICE="notification";Intent sent;int calls;boolean fail;void startService(Intent intent){calls++;if(fail)throw new IllegalStateException("Denied");sent=intent;}}
 static class Intent {String action;long epoch=-1;Intent(Context c,Class<?> target){}void setAction(String value){action=value;}void putExtra(String key,long value){epoch=value;}long getLongExtra(String key,long fallback){return epoch;}}
 void appendDiagnosticEvent(String event,Object value){diagnostics++;}void deleteLocalAgentTokenFile(){deleted++;}void persistDetachedLaunchTimestamp(long value){timestamps++;}long safePid(Process p){return 1;}void stopDetachedAgentProcess(){inventory.run();}void stopSelf(){}
 ${fields}
 ${launchPrefix} launches++;}}
 ${method(source, "    private void stopAgentProcess(boolean terminalStop) {")}
 ${method(source, "    private void stopAgentProcess(boolean terminalStop, boolean confirmTermination)")}
 ${method(source, "    private boolean stopAgentProcessForCredentialChange(")}
 ${method(source, "    private boolean stopAgentProcessOrPreserve(")}
 ${method(source, "    public void onDestroy(").replace("@Override", "")}
 int stopIntent(Intent intent){String action=intent.action;Object details=null;${stopBranch}return -1;}
 static class FakeProcess extends Process {boolean alive=true,stubborn,neverExits,interrupt;int kills;public OutputStream getOutputStream(){return OutputStream.nullOutputStream();}public InputStream getInputStream(){return InputStream.nullInputStream();}public InputStream getErrorStream(){return InputStream.nullInputStream();}public int waitFor(){alive=false;return 0;}public boolean waitFor(long value,TimeUnit unit)throws InterruptedException{onWait.run();if(interrupt)throw new InterruptedException();return !alive;}public int exitValue(){return 0;}public void destroy(){if(!stubborn)alive=false;}public Process destroyForcibly(){kills++;if(!neverExits)alive=false;return this;}public boolean isAlive(){return alive;}}
 static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}static ElizaAgentService service(){ElizaAgentService value=new ElizaAgentService();activeInstance=value;return value;}
 static void drain()throws Exception{for(int i=0;i<500&&credentialShutdownPending;i++)Thread.sleep(2);check(!credentialShutdownPending,"Release worker did not settle");}
 static void reset(){interruptedObserved=false;credentialShutdownPending=false;inventory=()->{};onWait=()->{};IpcStartupRecovery.sole=true;IpcStartupRecovery.checks=0;deleted=timestamps=schedulerStops=0;currentLocalAgentToken="protected-root";currentTerminalRunToken="protected-terminal";}
 public static void main(String[] args)throws Exception {
  int cases=0;Context context=new Context();reset();long request=stopForCredentialChange(context);ElizaAgentService owned=service();owned.stopIntent(context.sent);check(!isCredentialShutdownConfirmed(request),"Confirmed before teardown");owned.onDestroy();drain();check(isCredentialShutdownConfirmed(request)&&activeInstance==null,"Successful shutdown not confirmed");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.detachedAgentMode=true;owned.stopIntent(context.sent);inventory=()->{throw new IllegalStateException("Resident preserved");};IpcStartupRecovery.sole=false;owned.onDestroy();drain();check(!isCredentialShutdownConfirmed(request)&&currentLocalAgentToken!=null&&deleted==0&&owned.detachedAgentMode,"Refused stop lost ownership or confirmed");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);IpcStartupRecovery.sole=false;owned.onDestroy();drain();check(!isCredentialShutdownConfirmed(request)&&deleted==0&&currentLocalAgentToken!=null,"Resident-only stop admitted surviving same-UID worker");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);inventory=()->{throw new IllegalStateException("No extracted loader");};owned.onDestroy();drain();check(isCredentialShutdownConfirmed(request)&&IpcStartupRecovery.checks==2,"Cold sole-UID process not confirmed");cases++;
  for(String reason:new String[]{"Unadopted child","Unreadable inventory"}){reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);inventory=()->{throw new IllegalStateException(reason);};IpcStartupRecovery.sole=false;owned.onDestroy();drain();check(!isCredentialShutdownConfirmed(request)&&deleted==0,"Cold uncertain inventory confirmed");cases++;}
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);FakeProcess direct=new FakeProcess();direct.stubborn=true;owned.agentProcess=direct;owned.onDestroy();drain();check(isCredentialShutdownConfirmed(request)&&!direct.isAlive()&&direct.kills==1,"Confirmed kill was not awaited");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);direct=new FakeProcess();direct.stubborn=direct.neverExits=true;owned.agentProcess=direct;owned.onDestroy();drain();check(!isCredentialShutdownConfirmed(request)&&owned.agentProcess==direct&&currentLocalAgentToken!=null&&deleted==0,"Unconfirmed direct kill erased ownership");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);direct=new FakeProcess();direct.interrupt=true;owned.agentProcess=direct;owned.onDestroy();drain();check(!isCredentialShutdownConfirmed(request)&&interruptedObserved&&deleted==0,"Interrupted wait confirmed");cases++;
  reset();long old=stopForCredentialChange(context);Intent oldIntent=context.sent;int dispatched=context.calls;long same=stopForCredentialChange(context);check(same==old&&context.calls==dispatched,"Pending stop dispatched twice");owned=service();owned.stopIntent(oldIntent);owned.onDestroy();drain();long latest=stopForCredentialChange(context);check(!isCredentialShutdownConfirmed(old)&&!isCredentialShutdownConfirmed(latest),"Old shutdown proof rebound");owned=service();owned.stopIntent(context.sent);owned.onDestroy();drain();cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);try{invalidateCredentialShutdown();throw new AssertionError("Concurrent start admitted");}catch(IllegalStateException expected){}owned.onDestroy();drain();check(isCredentialShutdownConfirmed(request),"Refused start changed owned shutdown");invalidateCredentialShutdown();check(!isCredentialShutdownConfirmed(request),"Actual later start reused proof");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);direct=new FakeProcess();direct.stubborn=true;owned.agentProcess=direct;onWait=()->{try{invalidateCredentialShutdown();throw new AssertionError("Start during drain admitted");}catch(IllegalStateException expected){}};owned.onDestroy();drain();check(isCredentialShutdownConfirmed(request),"Refused start corrupted proof");cases++;
  reset();owned=service();Intent normal=new Intent(context,ElizaAgentService.class);normal.setAction(ACTION_STOP);owned.stopIntent(normal);owned.detachedAgentMode=true;inventory=()->{throw new IllegalStateException("Preserved normal stop");};owned.onDestroy();drain();check(deleted==0&&currentLocalAgentToken!=null,"Ordinary stop changed preservation semantics");cases++;
  reset();owned=service();owned.foregroundStartDenied=true;request=stopForCredentialChange(context);owned.stopIntent(context.sent);owned.onDestroy();drain();check(!isCredentialShutdownConfirmed(request),"Foreground denial confirmed preserved runtime");cases++;
  reset();context.fail=true;try{stopForCredentialChange(context);throw new AssertionError("Rejected request admitted");}catch(IllegalStateException expected){}check(!isCredentialShutdownConfirmed(credentialShutdownEpoch),"Failed request confirmed");cases++;
  reset();context.fail=false;request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);inventory=()->{entered.countDown();try{release.await(5,TimeUnit.SECONDS);}catch(InterruptedException e){throw new IllegalStateException(e);}};owned.onDestroy();check(entered.await(5,TimeUnit.SECONDS)&&credentialShutdownPending&&!isCredentialShutdownConfirmed(request),"Main callback blocked or published before drain");try{invalidateCredentialShutdown();throw new AssertionError("Start admitted during held drain");}catch(IllegalStateException expected){}release.countDown();drain();check(isCredentialShutdownConfirmed(request),"Held cleanup failed to confirm");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);owned.ipcRecovery=new Recovery();owned.onDestroy();drain();check(!isCredentialShutdownConfirmed(request),"Failed IPC release confirmed");cases++;
  reset();request=stopForCredentialChange(context);owned=service();owned.stopIntent(context.sent);ElizaAgentService queued=owned;Thread late;launches=0;synchronized(owned.processLock){late=new Thread(()->queued.startAgentProcess(true));late.start();owned.onDestroy();}late.join(5000);drain();check(!late.isAlive()&&launches==0&&isCredentialShutdownConfirmed(request),"Queued worker relaunched after teardown");cases++;
  System.out.println("PASS "+cases+" actual service credential shutdown cases");
 }
}`,
    [
      join(
        root,
        "plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime/NativeProcessSupervisor.java",
      ),
    ],
  );
  expect(output).toContain("PASS 18 actual service credential shutdown cases");
});

test("existing sole-full-UID absence gate refuses live children and unreadable or changing identities", () => {
  const recovery = readFileSync(
    join(native, "IpcStartupRecovery.java"),
    "utf8",
  );
  // Only /proc is ported to a real temporary fixture filesystem; algorithm and UID checks are unchanged.
  const gate = [
    "    private static IOException refused(",
    "    private static String bounded(",
    "    private static String identity(",
    "    static void requireSoleUidProcess(",
  ]
    .map((start) => method(recovery, start))
    .join("\n")
    .replaceAll('"/proc', 'PROC+"');
  const output = runJava(
    "UidAbsenceTest",
    `import java.io.*;import java.nio.file.*;import java.nio.charset.*;import java.util.*;
public class UidAbsenceTest {
 static String PROC;static int self=100;static Map<String,StructStat> values=new HashMap<>();static boolean unreadable,changed;static int selfReads;
 static class StructStat{int st_uid;long st_ino;StructStat(int uid,long inode){st_uid=uid;st_ino=inode;}}
 static class Process{static int myPid(){return self;}static int myUid(){return 10001;}}
 static class OsConstants{static final int ENOENT=2;}static class android{static class system{static class ErrnoException extends Exception{int errno=2;}}}
 static class Os{static StructStat stat(String path)throws Exception{if(unreadable)throw new IOException("Inventory unreadable");StructStat value=values.get(path);if(value==null)throw new android.system.ErrnoException();if(path.equals(PROC+"/100")&&changed&&++selfReads==2)return new StructStat(value.st_uid,value.st_ino+1);return value;}static String readlink(String path){return "/owned/runtime";}}
 ${gate}
 static void check(boolean value){if(!value)throw new AssertionError("Sole UID guard admitted uncertainty");}interface Task{void run()throws Exception;}static void denied(Task task)throws Exception{try{task.run();}catch(Exception expected){return;}throw new AssertionError("Expected inventory refusal");}
 static void process(int pid,int uid)throws Exception{Path dir=Path.of(PROC,String.valueOf(pid));Files.createDirectories(dir);values.put(dir.toString(),new StructStat(uid,pid));Files.writeString(dir.resolve("stat"),pid+" (fixture) S"+" 0".repeat(18)+" 123");Files.writeString(dir.resolve("cmdline"),"owned-runtime"+(char)0);}
 public static void main(String[] args)throws Exception{Path base=Files.createTempDirectory("uid-proof-");PROC=base.toString();try{for(int pid=100;pid<125;pid++)process(pid,pid==100?10001:20000);requireSoleUidProcess();int cases=1;process(101,10001);denied(UidAbsenceTest::requireSoleUidProcess);cases++;process(101,110001);requireSoleUidProcess();cases++;unreadable=true;denied(UidAbsenceTest::requireSoleUidProcess);cases++;unreadable=false;changed=true;selfReads=0;denied(UidAbsenceTest::requireSoleUidProcess);cases++;changed=false;Files.writeString(base.resolve("100/cmdline"),"incomplete");denied(UidAbsenceTest::requireSoleUidProcess);cases++;System.out.println("PASS "+cases+" actual full-UID absence cases");}finally{try(var paths=Files.walk(base)){paths.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.delete(p);}catch(IOException e){throw new UncheckedIOException(e);}});}}}
}`,
  );
  expect(output).toContain("PASS 6 actual full-UID absence cases");
});
