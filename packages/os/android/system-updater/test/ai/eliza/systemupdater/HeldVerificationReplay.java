// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Real files and exact runner/engine methods, with controlled Android service ports. */
public final class HeldVerificationReplay {
    static final String SOURCE = "alpha/fixture/device:source", TARGET = "alpha/fixture/device:target";
    static final String BOOT = "boot-1";
    static final byte[] PAYLOAD = {1, 2, 3, 4};

    static final class R {
        static final class string {
            static final int os_update_product = 1, os_update_device = 2, os_update_ota_certificate = 3;
        }
    }
    static final class Context {
        final File directory;
        final String certificate;
        final PowerManager power = new PowerManager();
        int finishes, schedules;
        boolean eligible = true;
        String status;
        Context(Path dir, String certificate) {
            this.directory = new File(dir.toString()) {
                @Override public long getUsableSpace() { return 3L * 1024 * 1024 * 1024; }
            };
            this.certificate = certificate;
        }
        File getFilesDir() { return directory; }
        String getString(int key) { return key == 1 ? "fixture" : key == 2 ? "device" : certificate; }
        <T> T getSystemService(Class<T> service) { return service.cast(power); }
    }
    static final class Run {
        boolean stopped, verifying;
        final Runnable finished;
        Run(Context context) { finished = () -> context.finishes++; }
    }
    static final class Handler {
        Handler(Looper ignored) { }
        void post(Runnable call) { call.run(); }
    }
    static final class Looper { static Looper getMainLooper() { return new Looper(); } }
    static final class Log { static void w(String tag, String message, Exception failure) { } }
    static final class PowerManager { int reboots; void reboot(String reason) { reboots++; } }
    static final class SystemUpdateJob {
        static void schedule(Context context, boolean immediate) { schedule(context, immediate, false); }
        static void schedule(Context context, boolean requested, boolean immediate) { context.schedules++; }
    }
    static final class UpdateChannel {
        Candidate initial, next;
        int discoveries, unavailableAt;
        UpdateChannel(Candidate candidate) { initial = next = candidate; }
        Candidate discover() throws IOException {
            int attempt = ++discoveries;
            if (attempt == unavailableAt) throw new IOException("Fixture could not read the offer");
            return attempt == 1 ? initial : next;
        }
        File download(Candidate candidate, File directory) { throw new AssertionError("Held candidate downloaded"); }
        static final class DownloadDeferred extends IOException { }
        static final class Candidate {
            final String fingerprint = TARGET;
            final String sha256;
            final long bytes, timestamp = 2;
            Candidate(String digest, long bytes) { this.sha256 = digest; this.bytes = bytes; }
        }
    }
    static final class JournalStore {
        static UpdateJournal journal;
        static int writes;
        final Path file;
        JournalStore(File directory) { file = directory.toPath().resolve("journal.fixture"); }
        void seed(UpdateJournal value) throws IOException {
            journal = value;
            Files.writeString(file, value.phase + "\n" + value.sourceBuild + "\n" + value.targetBuild
                    + "\n" + value.packageSha256 + "\n" + value.intentBoot);
        }
        UpdateJournal read() { return journal; }
        void write(UpdateJournal expected, UpdateJournal next) throws IOException {
            check(expected == journal, "Journal preimage differs");
            seed(next); writes++;
        }
    }
    static final class UpdateEngine {
        static int status, binds, unbinds;
        static final class UpdateStatusConstants { static final int UPDATED_NEED_REBOOT = 6; }
        boolean bind(UpdateEngineCallback callback, Handler handler) {
            binds++; callback.onStatusUpdate(status, 0); return true;
        }
        void unbind() { unbinds++; }
    }
    abstract static class UpdateEngineCallback {
        abstract void onStatusUpdate(int status, float progress);
        abstract void onPayloadApplicationComplete(int errorCode);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    private static byte[] hash(byte[] bytes) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(bytes);
    }
    private static void entry(ZipOutputStream zip, String name, byte[] bytes) throws IOException {
        zip.putNextEntry(new ZipEntry(name)); zip.write(bytes); zip.closeEntry();
    }
    private static Path ota(Path directory) throws Exception {
        Path archive = directory.resolve("fixture.zip");
        String payloadHash = Base64.getEncoder().encodeToString(hash(PAYLOAD));
        try (var zip = new ZipOutputStream(Files.newOutputStream(archive))) {
            entry(zip, "META-INF/com/android/metadata", ("ota-type=AB\npre-device=device\npre-build="
                    + SOURCE + "\npost-build=" + TARGET + "\npost-timestamp=2\npost-security-patch-level=2026-01-01\n")
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            entry(zip, "payload_properties.txt", ("FILE_SIZE=4\nMETADATA_SIZE=4\nFILE_HASH=" + payloadHash
                    + "\nMETADATA_HASH=" + payloadHash + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            entry(zip, "payload.bin", PAYLOAD);
        }
        return archive;
    }
    private static List<String> contents(Path directory) throws Exception {
        try (var entries = Files.walk(directory)) {
            List<String> inventory = new java.util.ArrayList<>();
            for (Path entry : entries.sorted().toList()) {
                String name = directory.relativize(entry).toString();
                if (Files.isSymbolicLink(entry)) inventory.add(name + "->" + Files.readSymbolicLink(entry));
                else if (Files.isRegularFile(entry)) inventory.add(name + "=" + HexFormat.of().formatHex(hash(Files.readAllBytes(entry))));
                else inventory.add(name);
            }
            return inventory;
        }
    }
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        byte[] cert = Files.readAllBytes(Path.of(args[1]));
        Path trust = root.resolve("otacerts.zip");
        try (var zip = new ZipOutputStream(Files.newOutputStream(trust))) {
            entry(zip, "fixture.x509", cert);
            if (args.length > 3) entry(zip, "rotation.x509", Files.readAllBytes(Path.of(args[3])));
        }
        System.setProperty("fixture.enrolled", args[1]);
        System.setProperty("fixture.otacerts", trust.toString());
        android.os.Build.FINGERPRINT = SOURCE;
        android.os.Build.VERSION.SECURITY_PATCH = "2026-01-01";
        boolean before = args[2].equals("before");
        var cases = List.of("missing", "invalid", "symlink", "missing-archive", "changed", "ineligible",
                "engine-idle", "ready", "initial-absent", "initial-different", "initial-unavailable",
                "recheck-absent", "recheck-unavailable");
        for (String mode : before ? List.of("missing") : cases) {
            Path directory = Files.createDirectory(root.resolve(mode));
            Path input = ota(directory);
            String digest = HexFormat.of().formatHex(hash(Files.readAllBytes(input)));
            var candidate = new UpdateChannel.Candidate(digest, Files.size(input));
            Path archive = directory.resolve(digest + ".zip"), payload = directory.resolve(digest + ".payload");
            if (mode.equals("missing-archive")) Files.delete(input); else Files.move(input, archive);
            if (mode.equals("invalid")) Files.write(payload, new byte[PAYLOAD.length]);
            else if (mode.equals("symlink")) Files.createSymbolicLink(payload, Path.of("absent"));
            else if (!mode.equals("missing") && !mode.equals("missing-archive")) Files.write(payload, PAYLOAD);
            Path scratch = Files.createDirectory(directory.resolve("pre-apply-payload-scratch-v1"));
            Files.createFile(scratch.resolve("owner"));
            Files.write(scratch.resolve("payload.partial"), PAYLOAD);
            Path legacy = Files.write(directory.resolve("payload-legacy.partial"), PAYLOAD);
            Context context = new Context(directory, HexFormat.of().formatHex(hash(cert)));
            JournalStore store = new JournalStore(context.directory);
            UpdateJournal held = UpdateJournal.idle().download(SOURCE, TARGET, digest)
                    .verified(SOURCE, TARGET, digest).applyIntent(BOOT, true).applying(BOOT)
                    .completedApply(BOOT, true, 0);
            store.seed(held); JournalStore.writes = 0;
            UpdateEngine.binds = UpdateEngine.unbinds = 0;
            UpdateEngine.status = mode.equals("ready") ? UpdateEngine.UpdateStatusConstants.UPDATED_NEED_REBOOT : 0;
            context.eligible = !mode.equals("ineligible");
            UpdateChannel channel = new UpdateChannel(candidate);
            var different = new UpdateChannel.Candidate("b".repeat(64), candidate.bytes);
            switch (mode) {
                case "initial-absent" -> channel.initial = null;
                case "initial-different" -> channel.initial = different;
                case "initial-unavailable" -> channel.unavailableAt = 1;
                case "changed" -> channel.next = different;
                case "recheck-absent" -> channel.next = null;
                case "recheck-unavailable" -> channel.unavailableAt = 2;
            }
            List<String> files = contents(directory);
            Path retained = Files.isRegularFile(payload, java.nio.file.LinkOption.NOFOLLOW_LINKS) ? payload : legacy;
            byte[] retainedBytes = Files.readAllBytes(retained);
            try (var open = Files.newInputStream(retained)) {
                new UpdateRunner(context).replay(store, channel);
                check(MessageDigest.isEqual(open.readAllBytes(), retainedBytes), "An open retained descriptor changed");
            }
            check(context.finishes == 1, "Held job did not finish exactly once");
            if (before) {
                check(Files.isRegularFile(payload) && UpdateEngine.binds == 1, "Old verifier did not materialize the missing held payload");
                System.out.println("before: missing payload was recreated before engine status");
                continue;
            }
            boolean ready = mode.equals("ready"), observed = ready || mode.equals("engine-idle");
            check(UpdateEngine.binds == (observed ? 1 : 0) && UpdateEngine.binds == UpdateEngine.unbinds, "Engine observation crossed held verification");
            check(context.power.reboots == (ready ? 1 : 0) && JournalStore.writes == (ready ? 1 : 0), "Unexpected reboot or journal write");
            boolean retry = List.of("ineligible", "changed", "recheck-absent").contains(mode);
            boolean rechecked = List.of("changed", "engine-idle", "ready", "recheck-absent", "recheck-unavailable").contains(mode);
            check(context.schedules == (retry ? 1 : 0), "Unexpected retry dispatch: " + mode);
            check(channel.discoveries == (rechecked ? 2 : 1), "Unexpected offer reads: " + mode);
            check(store.read().phase == (ready ? UpdateJournal.Phase.REBOOT_INTENT : UpdateJournal.Phase.REBOOT_READY), "Held phase changed");
            List<String> after = contents(directory);
            if (ready) { files.removeIf(row -> row.startsWith("journal.fixture=")); after.removeIf(row -> row.startsWith("journal.fixture=")); }
            check(files.equals(after), "Held verification changed artifact files: " + mode);
            System.out.println(mode + " " + store.read().phase + " " + UpdateEngine.binds + " "
                    + context.power.reboots + "\t" + context.status);
        }
    }
}
