import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(
  process.env.ELIZA_SERVICE_STOP_SOURCE ||
    join(
      app,
      "platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java",
    ),
  "utf8",
);
function method(signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, signature);
  let end = source.indexOf("{", start) + 1,
    depth = 1;
  while (depth) {
    assert.ok(end < source.length);
    depth += (source[end] === "{") - (source[end] === "}");
    end++;
  }
  return source.slice(start, end);
}
// Compile the actual service lifecycle methods with its real shared process supervisor.
// Android inventory, identity and context ports below are finite fixtures. They do NOT prove
// native worker authentication, Android deployment identity, SELinux or installed recovery.
const methods = [
  "private void stopAgentProcess(boolean terminalStop, boolean confirmTermination)",
  source.includes("private void stopDetachedAgentProcess(long deadline)")
    ? "private void stopDetachedAgentProcess(long deadline)"
    : "private void stopDetachedAgentProcess()",
  "public void onDestroy()",
  "private void requestAgentStart(boolean restartFirst)",
  "private boolean stopAgentProcessOrPreserve(boolean terminalStop)",
  "private boolean stopAgentProcessForCredentialChange()",
  "private void stopAgentProcess(boolean terminalStop)",
]
  .map(method)
  .join("\n");
const java = String.raw`
import java.io.*;import java.nio.file.*;import java.util.*;import java.util.concurrent.*;
class Base { public void onDestroy(){} }
class ElizaAgentService {}
public class StopRace extends Base {
 static java.util.concurrent.CompletableFuture<Void> serviceLifecycleCompletion=java.util.concurrent.CompletableFuture.completedFuture(null);
 static StopRace activeInstance;static long credentialShutdownEpoch;static boolean credentialShutdownConfirmed,credentialShutdownPending;
 long admittedCredentialShutdownEpoch=-1,recoveryMaintenanceEpoch;boolean shuttingDown,foregroundStartDenied;
 Thread watchdog,startWorker;String currentStatus="starting";int starts;
 static class Resource {void close(){}void stop(){}}
 Resource chromiumBrowserConnection,agentSecureStore,bionicInferenceServer;
 static class Lease {void close()throws IOException{}}
 Lease ipcRecovery;
 static class NotificationManager{void cancel(int id){}}
 static class Context{static final String NOTIFICATION_SERVICE="notification";}
 static final int NOTIFICATION_ID=1;Object getSystemService(String s){return null;}
 static void invalidateCredentialShutdown(){if(credentialShutdownPending)throw new IllegalStateException();++credentialShutdownEpoch;credentialShutdownConfirmed=false;}
 void ensureBionicVoiceHost(){}
 void updateNotification(){}
 static CountDownLatch startEntered,startProceed;void startAgentProcess(boolean adopt){starts++;if(startEntered!=null){startEntered.countDown();try{startProceed.await(2,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException(e);}}}

 static final long PROCESS_TERMINATE_GRACE_MS=500;
 final Object processLock=new Object(); Process agentProcess; Thread stdoutPump,stderrPump;
 boolean detachedAgentMode=true,ownershipStopped,credentialDeleted; long detachedLaunchStartedAtMs=123;
 String currentLocalAgentToken="retained-token",currentTerminalRunToken="retained-token";
 static final String AGENT_BUNDLE_NAME="agent-bundle.js",TAG="test";
 final Path dir;Process shell,workflow,unproven; volatile boolean expired;int stopChecks;
 static StopRace current;
 StopRace(Path d){dir=d;current=this;activeInstance=this;}
 Object getApplicationContext(){return this;} File getFilesDir(){return dir.toFile();}
 File agentStateDir(){return dir.resolve(".eliza").toFile();}File agentRoot(){return dir.toFile();}
 File agentAbiDir(String x){return dir.toFile();}File nativeLibraryDir(){return dir.toFile();}
 String resolveRuntimeAbi(){return "fixture";}String findMuslLoader(File f){return "loader";}
 String packagedMuslLoaderName(String x){return null;}
 File preferPackagedExecutable(File f,String n){return f;}static final String BUN_BINARY="bun";
 void deleteLocalAgentTokenFile(){credentialDeleted=true;}void persistDetachedLaunchTimestamp(long t){}
 long safePid(Process p){return p.pid();}void appendDiagnosticEvent(String event,Object detail){}
 static class Log {static void i(String t,String m){} static void w(String t,String m,Throwable e){} static void w(String t,String m){} }
 static class ElizaWorkScheduler {static void runtimeStopped(Object c){((StopRace)c).ownershipStopped=true;}}
 static class IpcStartupRecovery {static void requireSoleUidProcess()throws Exception{requireSoleUidProcess(Long.MAX_VALUE);}static void requireSoleUidProcess(long deadline)throws Exception {if(current.hasUnknown())throw new IOException("unknown");}}
 static class WorkflowSurvivorInventory {
  static void stopResident(File bun,File loader,File bundle)throws Exception{stopResident(bun,loader,bundle,Long.MAX_VALUE);}static void stopResident(File bun,File loader,File bundle,long deadline)throws Exception {
   StopRace h=current;h.stopChecks++;
   Path pid=h.dir.resolve("resident.pid");
   if(Files.exists(pid)){long id=Long.parseLong(Files.readString(pid).trim());ProcessHandle.of(id).ifPresent(ProcessHandle::destroy);}
  }
  static void requireClassified(File home,File state,File bun,File loader,long deadline)throws IOException {
   if(!state.toPath().equals(home.toPath().resolve(".eliza/smthrs")))throw new AssertionError("Wrong worker state scope");
   if(current.hasUnknown())throw new IOException("unregistered launch shell or unknown process");
  }
 }
 boolean hasUnknown(){return shell!=null&&shell.isAlive()||unproven!=null&&unproven.isAlive();}
 __METHODS__
 void cleanup()throws Exception {
  Path pid=dir.resolve("resident.pid");if(Files.exists(pid))ProcessHandle.of(Long.parseLong(Files.readString(pid).trim())).ifPresent(ProcessHandle::destroyForcibly);
  for(Process p:new Process[]{agentProcess,shell,workflow,unproven})if(p!=null){p.destroyForcibly();p.waitFor(2,TimeUnit.SECONDS);}
 }
 static void check(boolean b,String message){if(!b)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception {
  Path d=Path.of(args[0]);Files.createDirectories(d);
  StopRace race=new StopRace(d.resolve("race"));Files.createDirectories(race.dir);
  try {
   race.agentProcess=new ProcessBuilder("sh","-c","sleep 0.05").start();
   race.shell=new ProcessBuilder("sh","-c","while [ ! -f \"$1/go\" ]; do sleep 0.01; done; sleep 30 & p=$!; echo $p > \"$1/resident.pid\"; wait $p","sh",race.dir.toString()).start();
   race.workflow=new ProcessBuilder("sleep","30").start();
   Thread release=new Thread(()->{try{Thread.sleep(150);Files.writeString(race.dir.resolve("go"),"1");}catch(Exception e){throw new RuntimeException(e);}});release.start();
   race.stopAgentProcess(true,false);release.join();
   check(race.ownershipStopped,"Expected stopped ownership after proved absence");
   check(!race.shell.isAlive(),"STOP published before detached launch shell settled");
   check(race.workflow.isAlive(),"Fixture-admitted workflow sibling must survive");
   check(race.credentialDeleted,"Credential cleanup follows proof");
   check(race.stopChecks>1,"Race must exercise bounded repeated resident inventory");
  }finally{race.cleanup();}
  StopRace unknown=new StopRace(d.resolve("unknown"));Files.createDirectories(unknown.dir);
  try{
   unknown.agentProcess=new ProcessBuilder("sh","-c","exit 0").start();unknown.unproven=new ProcessBuilder("sleep","30").start();
   boolean refused=false;try{unknown.stopAgentProcess(true,false);}catch(IllegalStateException expected){refused=true;}
   check(refused,"Unknown live process must refuse stop acknowledgement");
   check(!unknown.ownershipStopped&&!unknown.credentialDeleted,"Refusal must retain ownership and credential state");
   check(unknown.currentLocalAgentToken!=null&&unknown.detachedAgentMode,"Retryable owner state retained");
   check(unknown.unproven.isAlive(),"Unproven process must not be signaled");
  }finally{unknown.cleanup();}
  StopRace previous=new StopRace(d.resolve("gate"));Files.createDirectories(previous.dir);
  try{
   previous.agentProcess=new ProcessBuilder("sh","-c","sleep 0.05").start();
   previous.shell=new ProcessBuilder("sh","-c","while [ ! -f \"$1/go\" ]; do sleep 0.01; done; sleep 30 & p=$!; echo $p > \"$1/resident.pid\"; wait $p","sh",previous.dir.toString()).start();
   previous.shuttingDown=true;
   long began=System.nanoTime();previous.onDestroy();
   check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-began)<100,"Android lifecycle callback must not wait for process shutdown");
   StopRace successor=new StopRace(d.resolve("successor"));current=previous;
   successor.requestAgentStart(false);Thread.sleep(80);
   check(successor.starts==0&&!serviceLifecycleCompletion.isDone(),"Successor cannot initialize IPC while prior teardown is pending");
   Files.writeString(previous.dir.resolve("go"),"1");
   serviceLifecycleCompletion.get(2,TimeUnit.SECONDS);
   Thread next=successor.startWorker;if(next!=null)next.join(2000);
   check(successor.starts==1,"Normal startup resumes after release");
   check(!credentialShutdownConfirmed,"Ordinary worker-preserving stop must never grant strict credential acknowledgement");
  }finally{previous.cleanup();}
  StopRace strict=new StopRace(d.resolve("strict"));Files.createDirectories(strict.dir);
  try{
   strict.agentProcess=new ProcessBuilder("sh","-c","exit 0").start();
   strict.shuttingDown=true;strict.admittedCredentialShutdownEpoch=credentialShutdownEpoch=42;credentialShutdownPending=true;
   strict.onDestroy();serviceLifecycleCompletion.get(2,TimeUnit.SECONDS);
   check(credentialShutdownConfirmed&&!credentialShutdownPending&&activeInstance==null,"Strict credential acknowledgement requires proved release and matching epoch");
  }finally{strict.cleanup();}
  StopRace reserved=new StopRace(d.resolve("reserved"));Files.createDirectories(reserved.dir);
  startEntered=new CountDownLatch(1);startProceed=new CountDownLatch(1);
  reserved.requestAgentStart(false);check(startEntered.await(2,TimeUnit.SECONDS),"Start reservation must enter");
  StopRace laterRelease=new StopRace(d.resolve("later"));Files.createDirectories(laterRelease.dir);laterRelease.shuttingDown=true;
  laterRelease.onDestroy();Thread.sleep(50);
  check(!laterRelease.ownershipStopped&&!serviceLifecycleCompletion.isDone(),"Release registered after start reservation must wait until it settles");
  startProceed.countDown();serviceLifecycleCompletion.get(2,TimeUnit.SECONDS);
  check(laterRelease.ownershipStopped,"Queued release must finish after earlier startup");startEntered=null;startProceed=null;
  CompletableFuture<Void> blocked=new CompletableFuture<>();serviceLifecycleCompletion=blocked;
  StopRace waiting=new StopRace(d.resolve("waiting"));waiting.requestAgentStart(false);Thread pending=waiting.startWorker;pending.join(2000);
  check(waiting.starts==0&&!serviceLifecycleCompletion.isDone(),"Timed out reservation cannot cut an unfinished predecessor out of queue");
  StopRace queuedRelease=new StopRace(d.resolve("queued"));Files.createDirectories(queuedRelease.dir);queuedRelease.shuttingDown=true;queuedRelease.onDestroy();
  Thread.sleep(50);check(!queuedRelease.ownershipStopped,"Queued release cannot bypass timed out reservation's predecessor");
  blocked.complete(null);serviceLifecycleCompletion.get(2,TimeUnit.SECONDS);check(queuedRelease.ownershipStopped,"Queue resumes when predecessor really completes");
  StopRace retried=new StopRace(d.resolve("retried"));retried.requestAgentStart(false);Thread retry=retried.startWorker;if(retry!=null)retry.join(2000);check(retried.starts==1,"Startup remains retryable after temporary wait timeout");
  System.out.println("PASS actual detached child race, launcher settled before release, fixture-admitted sibling preserved, unknown process refused with owner state intact; async release fences successor startup and strict credential acknowledgement; late release and timeout preserve lifecycle ordering");
 }
}
`;
test("Android stop settles a delayed detached fork before ownership release and orders successor starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "eliza-service-stop-"));
  try {
    writeFileSync(
      join(dir, "StopRace.java"),
      java.replace("__METHODS__", methods),
    );
    mkdirSync(join(dir, "android/os"), { recursive: true });
    writeFileSync(
      join(dir, "android/os/SystemClock.java"),
      "package android.os;public class SystemClock {public static long elapsedRealtime(){return System.nanoTime()/1000000;}public static void sleep(long ms){try{Thread.sleep(ms);}catch(InterruptedException e){Thread.currentThread().interrupt();}}}",
    );
    const compiler = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin/javac")
      : "javac";
    const runtime = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin/java")
      : "java";
    execFileSync(
      compiler,
      [
        "-d",
        dir,
        resolve(
          app,
          "../../plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime/NativeProcessSupervisor.java",
        ),
        join(dir, "android/os/SystemClock.java"),
        join(dir, "StopRace.java"),
      ],
      { timeout: 15000, stdio: "pipe" },
    );
    const result = execFileSync(
      runtime,
      ["-cp", dir, "StopRace", join(dir, "state")],
      { timeout: 15000, encoding: "utf8" },
    );
    assert.match(result, /PASS actual detached child race/);
    assert.match(
      result,
      /late release and timeout preserve lifecycle ordering/,
    );
    // Scheduled starts use the same authority rather than bypassing the lifecycle reservation.
    assert.match(source, /requestAgentStart\(requireFreshProcess\)/);
    assert.doesNotMatch(source, /startAgentProcess\(!requireFreshProcess\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
