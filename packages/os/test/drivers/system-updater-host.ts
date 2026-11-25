import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SystemUpdaterHostKind = "storage" | "scratch" | "held";

export const SYSTEM_UPDATER_HOST_REPLAYS: Record<string, SystemUpdaterHostKind> = {
  "ai.eliza.systemupdater.StorageReplay": "storage",
  "ai.eliza.systemupdater.ScratchReplay": "scratch",
  "ai.eliza.systemupdater.HeldVerificationReplay": "held",
};

const PACKAGE = path.resolve(import.meta.dirname, "../..");
const CACHE = path.join(PACKAGE, ".cache", "jvm");
const RUNNER = "aosp/system-updater/host/ai/eliza/systemupdater/UpdateRunner.java";
const VERIFIER = "aosp/system-updater/src/ai/eliza/systemupdater/PackageVerifier.java";
const JOURNAL = "aosp/system-updater/src/ai/eliza/systemupdater/UpdateJournal.java";
const PAYLOAD = "aosp/system-updater/src/ai/eliza/systemupdater/VerifiedPayload.java";
const ENGINE = "aosp/system-updater/src/ai/eliza/systemupdater/EngineInstaller.java";
const STORAGE_REPLAY = "test/drivers/java/system-updater/ai/eliza/systemupdater/StorageReplay.java";
const SCRATCH_REPLAY = "test/drivers/java/system-updater/ai/eliza/systemupdater/ScratchReplay.java";
const HELD_REPLAY = "test/drivers/java/system-updater/ai/eliza/systemupdater/HeldVerificationReplay.java";

const tool = (name: string) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

function member(source: string, signature: string): string {
  const start = source.indexOf(`    ${signature}`);
  if (start < 0) throw new Error(`Missing production member: ${signature}`);
  const end = source.indexOf("\n    }", start);
  if (end <= start) throw new Error(`Missing production member end: ${signature}`);
  return source.slice(start, end + "\n    }".length);
}

function runnerFailurePort(source: string): string {
  const runnerMethods = [
    "synchronized boolean stop(",
    "private void failure(",
    "private synchronized void finish(",
  ].map((signature) => member(source, signature)).join("\n");
  return `package ai.eliza.systemupdater;
import java.security.GeneralSecurityException;
import static ai.eliza.systemupdater.StorageReplay.*;
final class UpdateRunner {
    final Context context;
    final Handler main;
    Run active;
    UpdateRunner(Context context) { this.context = context; main = new Handler(context); }
    static void status(Context context, String message) { context.message = message; }
    void report(Run run, Exception error) { failure(run, error); }
${runnerMethods}
}
`;
}

function runnerHeldPort(source: string): string {
  const start = source.indexOf("            UpdateChannel.Candidate candidate");
  const end = source.indexOf("            if (current.phase != UpdateJournal.Phase.VERIFIED", start);
  if (start < 0 || end <= start) throw new Error("Missing held verification and reboot dispatch");
  const dispatch = source.slice(start, end);
  if (!dispatch.includes("PackageVerifier.verify(")
    || !dispatch.includes("rebootIfAllowed(run, store, channel, candidate); return;")) {
    throw new Error("Held dispatch does not verify and then reboot");
  }
  const runnerMethods = [
    "private void rebootIfAllowed(",
    "private static boolean same(",
    "private void failure(",
    "private synchronized void finish(",
    "private static String heldOfferStatus(",
    "private void heldOfferUnavailable(",
  ].map((signature) => member(source, signature)).join("\n");
  return `package ai.eliza.systemupdater;
import android.os.Build;
import java.io.*;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import static ai.eliza.systemupdater.HeldVerificationReplay.*;
final class UpdateRunner {
    final Context context;
    final Handler main = new Handler(Looper.getMainLooper());
    Run active;
    JournalStore store;
    UpdateRunner(Context context) { this.context = context; }
    static void status(Context context, String message) { context.status = message; }
    boolean installAllowed() { return context.eligible; }
    void replay(JournalStore store, UpdateChannel channel) {
        Run run = active = new Run(context);
        this.store = store;
        File directory = context.getFilesDir();
        UpdateJournal current = store.read();
        try {
${dispatch}
            throw new AssertionError("Held candidate reached apply dispatch");
        } catch (Exception failure) { failure(run, failure); }
    }
${runnerMethods}
}
`;
}

function engineInstallerPort(source: string): string {
  return `package ai.eliza.systemupdater;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static ai.eliza.systemupdater.HeldVerificationReplay.*;
final class EngineInstaller {
${member(source, "static int observeStatus(")}
}
`;
}

function verifierStoragePort(source: string): string {
  return `package ai.eliza.systemupdater;
import java.io.File;
import java.io.IOException;
final class PackageVerifier {
${member(source, "static final class StorageDeferred")}
${member(source, "static void requirePayloadSpace(")}
}
`;
}

function verifierHeldSource(source: string): string {
  const trustPath = 'new ZipFile("/system/etc/security/otacerts.zip")';
  if (!source.includes(trustPath)) throw new Error("Missing production trust store path");
  return source.replace(trustPath, 'new ZipFile(System.getProperty("fixture.otacerts"))');
}

const SCRATCH_PORTS: Record<string, string> = {
  "android/os/Build.java": `package android.os;
public final class Build { public static long TIME; public static String FINGERPRINT;
 public static final class VERSION { public static String SECURITY_PATCH; } }`,
  "android/os/RecoverySystem.java": `package android.os;
public final class RecoverySystem { public static void verifyPackage(java.io.File file, Object a, Object b) {
 throw new AssertionError("Android package verification is outside this replay"); } }`,
  "android/os/ParcelFileDescriptor.java": `package android.os;
public final class ParcelFileDescriptor { public static final int MODE_READ_ONLY = 0;
 public static ParcelFileDescriptor open(java.io.File file, int mode) {
 throw new AssertionError("Engine descriptor is outside this replay"); } }`,
  "android/content/res/AssetFileDescriptor.java": `package android.content.res;
public final class AssetFileDescriptor { public AssetFileDescriptor(android.os.ParcelFileDescriptor fd, long offset, long size) {
 throw new AssertionError("Engine descriptor is outside this replay"); } }`,
  "android/system/ErrnoException.java": `package android.system;
public final class ErrnoException extends Exception {
 public final int errno;
 public ErrnoException(String operation, int errno, Throwable cause) {
  super(operation, cause);
  this.errno = errno;
 }
}`,
  "android/system/OsConstants.java": `package android.system;
public final class OsConstants {
 public static final int O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 64, O_EXCL = 128,
  O_NOFOLLOW = 131072, O_CLOEXEC = 524288, EIO = 5, ENOSPC = 28, EDQUOT = 122;
}`,
  "android/system/Os.java": `package android.system;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.IdentityHashMap;
public final class Os {
 static String fault;
 static int errno;
 static boolean wrotePrefix;
 static String interruptAfter;
 static long interruptBytes;
 private static int payloadSyncs;
 static final class State {
  final Path path;
  final FileOutputStream out;
  final FileInputStream in;
  final boolean directory;
  long position;
  State(Path path, FileOutputStream out, FileInputStream in, boolean directory) {
   this.path = path; this.out = out; this.in = in; this.directory = directory;
  }
 }
 static final IdentityHashMap<FileDescriptor, State> open = new IdentityHashMap<>();
 public static void failNext(String operation, int errno) { fault = operation; Os.errno = errno; wrotePrefix = false; }
 public static void interruptAfter(String operation, long bytes) { interruptAfter = operation; interruptBytes = bytes; }
 public static int payloadSyncs() { return payloadSyncs; }
 static void checkFault(String operation, Path path) throws ErrnoException {
  if ((operation + ":" + path.getFileName()).equals(fault)) {
   if (operation.equals("write") && !wrotePrefix) { wrotePrefix = true; return; }
   fault = null;
   throw new ErrnoException(operation, errno, null);
  }
 }
 public static int mkdir(String path, int mode) throws ErrnoException {
  try { checkFault("mkdir", Path.of(path)); Files.createDirectory(Path.of(path)); }
  catch (IOException error) { throw new ErrnoException("mkdir", OsConstants.EIO, error); }
  return 0;
 }
 public static FileDescriptor open(String name, int flags, int mode) throws ErrnoException {
  Path path = Path.of(name);
  try {
   checkFault("open", path);
   boolean create = (flags & OsConstants.O_CREAT) != 0;
   if (create && (flags & OsConstants.O_EXCL) == 0) throw new AssertionError("missing O_EXCL");
   if ((flags & OsConstants.O_NOFOLLOW) != 0 && Files.isSymbolicLink(path)) throw new IOException("Refusing to follow a symbolic link");
   if (create && Files.exists(path, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Scratch file already exists");
   if (Files.isDirectory(path)) {
    FileDescriptor descriptor = new FileDescriptor();
    open.put(descriptor, new State(path, null, null, true));
    return descriptor;
   }
   FileDescriptor descriptor;
   if ((flags & OsConstants.O_WRONLY) != 0) {
    FileOutputStream out = new FileOutputStream(path.toFile());
    descriptor = out.getFD();
    open.put(descriptor, new State(path, out, null, false));
   } else {
    FileInputStream in = new FileInputStream(path.toFile());
    descriptor = in.getFD();
    open.put(descriptor, new State(path, null, in, false));
   }
   return descriptor;
  } catch (IOException error) { throw new ErrnoException("open", OsConstants.EIO, error); }
 }
 public static int write(FileDescriptor descriptor, byte[] buffer, int offset, int count) throws ErrnoException {
  State state = open.get(descriptor);
  Path path = state.path;
  try {
   checkFault("write", path);
   int requested = Math.min(count, 4096);
   state.out.write(buffer, offset, requested);
   state.position += requested;
   if (("write:" + path.getFileName()).equals(interruptAfter) && state.position == interruptBytes) Thread.currentThread().interrupt();
   return requested;
  } catch (IOException error) { throw new ErrnoException("write", OsConstants.EIO, error); }
 }
 public static void fsync(FileDescriptor descriptor) throws ErrnoException {
  State state = open.get(descriptor);
  Path path = state.path;
  checkFault("fsync", path);
  try {
   if (path.getFileName().toString().equals("payload.partial")) payloadSyncs++;
   if (!state.directory) descriptor.sync();
   if (("fsync:" + path.getFileName()).equals(interruptAfter)) Thread.currentThread().interrupt();
  } catch (IOException error) { throw new ErrnoException("fsync", OsConstants.EIO, error); }
 }
 public static void close(FileDescriptor descriptor) throws ErrnoException {
  State state = open.remove(descriptor);
  try {
   if (state != null && !state.directory) {
    if (state.out != null) state.out.close();
    else if (state.in != null) state.in.close();
   }
  } catch (IOException error) { throw new ErrnoException("close", OsConstants.EIO, error); }
 }
}`,
};

const HELD_RECOVERY_SYSTEM = `package android.os;
public final class RecoverySystem { public static void verifyPackage(java.io.File file, Object a, Object b) {
 try (java.util.zip.ZipFile selected = new java.util.zip.ZipFile((java.io.File) b)) {
  if (selected.size() != 1) throw new AssertionError("Unexpected trust store size");
  byte[] cert = selected.getInputStream(selected.entries().nextElement()).readAllBytes();
  if (!java.util.Arrays.equals(cert, java.nio.file.Files.readAllBytes(java.nio.file.Path.of(System.getProperty("fixture.enrolled")))))
   throw new AssertionError("Wrong enrolled certificate selected");
 } catch (java.io.IOException error) { throw new AssertionError(error); }
} }`;

export interface HostReplaySources {
  readonly main: string;
  readonly files: readonly string[];
  readonly generated: ReadonlyMap<string, string>;
}

export function hostReplaySources(kind: SystemUpdaterHostKind): HostReplaySources {
  const runner = readFileSync(path.join(PACKAGE, RUNNER), "utf8");
  const verifier = readFileSync(path.join(PACKAGE, VERIFIER), "utf8");
  const journal = path.join(PACKAGE, JOURNAL);
  const generated = new Map<string, string>();
  if (kind === "storage") {
    generated.set("ai/eliza/systemupdater/UpdateRunner.java", runnerFailurePort(runner));
    generated.set("ai/eliza/systemupdater/PackageVerifier.java", verifierStoragePort(verifier));
    return {
      main: "ai.eliza.systemupdater.StorageReplay",
      files: [journal, path.join(PACKAGE, STORAGE_REPLAY)],
      generated,
    };
  }
  const payload = path.join(PACKAGE, PAYLOAD);
  if (kind === "scratch") {
    for (const [name, source] of Object.entries(SCRATCH_PORTS)) generated.set(name, source);
    generated.set("ai/eliza/systemupdater/UpdateRunner.java", runnerFailurePort(runner));
    return {
      main: "ai.eliza.systemupdater.ScratchReplay",
      files: [path.join(PACKAGE, VERIFIER), payload, journal, path.join(PACKAGE, SCRATCH_REPLAY), path.join(PACKAGE, STORAGE_REPLAY)],
      generated,
    };
  }
  const engine = readFileSync(path.join(PACKAGE, ENGINE), "utf8");
  for (const [name, source] of Object.entries(SCRATCH_PORTS)) {
    if (name !== "android/os/RecoverySystem.java") generated.set(name, source);
  }
  generated.set("ai/eliza/systemupdater/UpdateRunner.java", runnerHeldPort(runner));
  generated.set("ai/eliza/systemupdater/EngineInstaller.java", engineInstallerPort(engine));
  generated.set("ai/eliza/systemupdater/PackageVerifier.java", verifierHeldSource(verifier));
  generated.set("android/os/RecoverySystem.java", HELD_RECOVERY_SYSTEM);
  return {
    main: "ai.eliza.systemupdater.HeldVerificationReplay",
    files: [journal, payload, path.join(PACKAGE, HELD_REPLAY)],
    generated,
  };
}

export function compileHostReplay(kind: SystemUpdaterHostKind): string {
  const { files, generated } = hostReplaySources(kind);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(path.relative(PACKAGE, file));
    digest.update(readFileSync(file, "utf8"));
  }
  for (const [name, source] of generated) {
    digest.update(name);
    digest.update(source);
  }
  const classes = path.join(CACHE, `system-updater-host-${kind}-${digest.digest("hex").slice(0, 24)}`);
  if (existsSync(classes)) return classes;
  mkdirSync(CACHE, { recursive: true });
  const staging = mkdtempSync(path.join(CACHE, ".system-updater-host-"));
  try {
    const sources: string[] = [...files];
    for (const [name, source] of generated) {
      const file = path.join(staging, "sources", name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
      sources.push(file);
    }
    const classesStaging = path.join(staging, "classes");
    execFileSync(tool("javac"), ["--release", "21", "-encoding", "UTF-8", "-nowarn", "-d", classesStaging, ...sources], { stdio: ["ignore", "ignore", "pipe"] });
    renameSync(classesStaging, classes);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    const stderr = (error as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    throw new Error(`javac could not compile the system-update ${kind} host replay:\n${stderr || String(error)}`);
  }
  rmSync(staging, { recursive: true, force: true });
  return classes;
}

export function compileSystemUpdaterHosts(): { readonly compiled: readonly string[]; readonly failed: readonly string[] } {
  const compiled: string[] = [];
  const failed: string[] = [];
  for (const kind of ["storage", "scratch", "held"] as const) {
    try {
      compiled.push(compileHostReplay(kind));
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { compiled, failed };
}
