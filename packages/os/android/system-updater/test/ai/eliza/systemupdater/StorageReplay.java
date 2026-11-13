// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;

/** Host ports for the extracted production storage guard and runner failure path. */
public final class StorageReplay {
    private static final long RESERVE = 2L * 1024 * 1024 * 1024;
    private static final long PAYLOAD_SIZE = 4096;
    private static final byte[] ARCHIVE = "Retained fixture archive".getBytes(StandardCharsets.UTF_8);
    private static final String DIGEST = digest(ARCHIVE);

    static final class Context {
        final File directory;
        String message = "";
        int posts, schedules, finishes, writes;

        Context(Path directory) { this.directory = directory.toFile(); }
        File getFilesDir() { return directory; }
    }

    static final class Run {
        final int job = 1;
        final Runnable finished;
        final CompletableFuture<Void> task = new CompletableFuture<>();
        boolean stopped, applying, verifying = true;

        Run(Context context) { finished = () -> context.finishes++; }
    }

    static final class Handler {
        final Context context;
        Handler(Context context) { this.context = context; }
        void post(Runnable finished) { context.posts++; finished.run(); }
    }

    static final class Log {
        static void w(String tag, String message, Exception error) { }
    }

    static final class SystemUpdateJob {
        static void schedule(Context context, boolean requested, boolean immediate) { context.schedules++; }
    }

    static final class UpdateChannel {
        static final class DownloadDeferred extends IOException { }
    }

    // Android AtomicFile and JSON are outside this host check. The port retains the
    // actual production UpdateJournal state in a private file and counts runner writes.
    static final class JournalStore {
        static Context context;
        final Path path;

        JournalStore(File directory) { path = directory.toPath().resolve("journal.fixture"); }

        UpdateJournal read() throws IOException {
            String[] fields = Files.readString(path).split("\n", -1);
            return new UpdateJournal(UpdateJournal.Phase.valueOf(fields[0]),
                    fields[1], fields[2], fields[3], fields[4]);
        }

        void write(UpdateJournal expected, UpdateJournal next) throws IOException {
            require(Files.readString(path).equals(encode(expected)), "Journal preimage changed");
            seed(next);
            context.writes++;
        }

        void seed(UpdateJournal next) throws IOException { Files.writeString(path, encode(next)); }

        private static String encode(UpdateJournal journal) {
            return String.join("\n", journal.phase.name(), journal.sourceBuild, journal.targetBuild,
                    journal.packageSha256, journal.intentBoot);
        }
    }

    private final String name;
    private final Context context;
    private final UpdateRunner runner;
    private final JournalStore store;
    private final Path archive;
    private Run run;
    private boolean verified, checked, storageReady = true;
    private long usable = -1, required = -1;

    private StorageReplay(Path root, String name) throws IOException {
        this.name = name;
        Path directory = Files.createDirectory(root.resolve(name));
        context = new Context(directory);
        JournalStore.context = context;
        runner = new UpdateRunner(context);
        store = new JournalStore(context.directory);
        store.seed(UpdateJournal.idle());
        archive = directory.resolve(DIGEST + ".zip");
        Files.write(archive, ARCHIVE);
        observe("init");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static String digest(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (GeneralSecurityException unavailable) { throw new AssertionError(unavailable); }
    }

    private void observe(String action) throws IOException {
        byte[] retained = Files.readAllBytes(archive);
        require(digest(retained).equals(DIGEST), "Retained archive changed");
        System.out.printf(Locale.ROOT,
                "{\"case\":\"%s\",\"action\":\"%s\",\"phase\":\"%s\",\"active\":%b,"
                + "\"stopped\":%b,\"verified\":%b,\"checked\":%b,\"storageReady\":%b,"
                + "\"journalWrites\":%d,\"finishPosts\":%d,\"finishes\":%d,\"scheduleCalls\":%d,"
                + "\"journalSha256\":\"%s\",\"archiveSha256\":\"%s\","
                + "\"usableBytes\":%d,\"requiredBytes\":%d}%n",
                name, action, store.read().phase.name().toLowerCase(Locale.ROOT), runner.active != null,
                run != null && run.stopped, verified, checked, storageReady, context.writes,
                context.posts, context.finishes, context.schedules, digest(Files.readAllBytes(store.path)),
                digest(retained), usable, required);
    }

    private void start() throws IOException {
        run = new Run(context);
        runner.active = run;
        checked = false;
        observe("start");
    }

    private void download() throws IOException {
        store.seed(store.read().download("source", "target", DIGEST));
        observe("download");
    }

    private void stop() throws IOException {
        require(runner.stop(run.job) && run.task.isCancelled(), "Pre-apply cancellation was not observed");
        checked = false;
        observe("stop");
    }

    private IOException measure(long size) throws IOException {
        usable = context.directory.getUsableSpace();
        required = Math.addExact(size, RESERVE);
        File destination = new File(context.directory, DIGEST + ".payload");
        require(!destination.exists(), "Fixture unexpectedly has an extracted payload");
        try { PackageVerifier.requirePayloadSpace(context.directory, destination, size); }
        catch (IOException refused) { return refused; }
        return null;
    }

    private void verify() throws IOException {
        require(measure(PAYLOAD_SIZE) == null, "Host needs at least 2 GiB usable space for the ready control");
        if (!storageReady) { storageReady = true; observe("storage"); }
        UpdateJournal journal = store.read();
        if (journal.phase == UpdateJournal.Phase.DOWNLOADING) {
            // The production journal transition after the verifier succeeds. Trust and
            // extraction are separate boundaries and are not exercised by this fixture.
            store.seed(journal.verified("source", "target", DIGEST));
        }
        verified = true;
        checked = true;
        observe("verify");
    }

    private void defer(boolean before, boolean measuredLowVolume, boolean stopped) throws IOException {
        // Portable runs vary the requested size, never the real capacity reading.
        long size = measuredLowVolume ? PAYLOAD_SIZE : Math.addExact(context.directory.getUsableSpace(), PAYLOAD_SIZE);
        IOException refusal = measure(size);
        require(refusal != null && usable < required, "The real filesystem storage guard did not refuse");
        storageReady = false;
        observe("storage");
        byte[] journal = Files.readAllBytes(store.path);
        UpdateJournal.Phase phase = store.read().phase;
        int finished = context.posts;
        runner.report(run, refusal);
        if (before && !stopped) {
            require(store.read().phase == UpdateJournal.Phase.FAILED && context.writes == 1,
                    "The old runner did not persist its terminal rejection");
            observe("beforeStickyFailure");
            return;
        }
        require(store.read().phase == phase && MessageDigest.isEqual(journal, Files.readAllBytes(store.path)),
                "Storage pressure changed the durable journal");
        require(context.writes == 0 && context.schedules == 0 && runner.active == null,
                "Storage refusal dispatched a write or immediate retry");
        require(context.posts == finished + (stopped ? 0 : 1) && context.finishes == context.posts,
                "Storage refusal did not finish the owned live run exactly once");
        if (!stopped) require(context.message.equals("Waiting for enough storage to verify the system update"),
                "Storage refusal did not report waiting for capacity");
        observe(stopped ? "observe" : "deferStorage");
    }

    private static void recovery(Path root, String name, boolean previouslyVerified, boolean before,
            boolean measuredLowVolume) throws IOException {
        StorageReplay fixture = new StorageReplay(root, name);
        fixture.start(); fixture.download();
        if (previouslyVerified) { fixture.verify(); fixture.stop(); fixture.start(); }
        fixture.defer(before, measuredLowVolume, false);
        if (!before && !measuredLowVolume) { fixture.start(); fixture.verify(); }
    }

    public static void main(String[] args) throws IOException {
        Path root = Path.of(args[0]);
        boolean before = args[1].equals("before");
        recovery(root, "downloading-deferral", false, before, false);
        recovery(root, "verified-deferral", true, before, false);
        StorageReplay stopped = new StorageReplay(root, "stopped-deferral");
        stopped.start(); stopped.download(); stopped.stop(); stopped.defer(before, false, true);
        StorageReplay rejected = new StorageReplay(root, "trust-rejection");
        rejected.start(); rejected.download();
        if (!before) {
            rejected.defer(false, false, false);
            rejected.start();
            require(rejected.measure(PAYLOAD_SIZE) == null, "Capacity guard should now admit the candidate");
            rejected.storageReady = true;
            rejected.observe("storage");
        }
        rejected.runner.report(rejected.run, new GeneralSecurityException("Fixture trust rejection"));
        require(rejected.store.read().phase == UpdateJournal.Phase.FAILED && rejected.context.writes == 1
                && rejected.context.posts == (before ? 1 : 2) && rejected.context.schedules == 0
                && rejected.context.message.equals("System update signature was refused"),
                "Trust rejection must remain terminal");
        rejected.observe("reject");
        StorageReplay applied = new StorageReplay(root, "already-applied-guard");
        applied.start(); applied.download(); applied.verify();
        UpdateJournal applying = applied.store.read().applyIntent("boot", true).applying("boot");
        UpdateJournal unknown = applying.reconcile("source", "boot");
        for (UpdateJournal journal : new UpdateJournal[]{applying, unknown}) {
            applied.store.seed(journal);
            byte[] exact = Files.readAllBytes(applied.store.path);
            applied.runner.active = applied.run;
            IOException refusal = applied.measure(Math.addExact(applied.context.directory.getUsableSpace(), PAYLOAD_SIZE));
            require(refusal != null, "Defensive storage guard did not refuse");
            applied.runner.report(applied.run, refusal);
            require(MessageDigest.isEqual(exact, Files.readAllBytes(applied.store.path))
                    && applied.context.writes == 0 && applied.context.schedules == 0,
                    "Verification failure changed an applying or uncertain journal");
            applied.observe("defensiveObserve");
        }
        if (args.length == 3) recovery(Path.of(args[2]), "measured-low-volume", false, before, true);
    }
}
