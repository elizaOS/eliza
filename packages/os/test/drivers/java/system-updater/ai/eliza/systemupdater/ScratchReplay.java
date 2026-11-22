// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Replay actual extraction on a private file tree across abrupt JVM termination. */
public final class ScratchReplay {
    private static final byte[] PAYLOAD = new byte[64 * 1024];
    static { for (int i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (byte) i; }

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String mode = args[1];
        for (UpdateJournal.Phase phase : UpdateJournal.Phase.values()) {
            UpdateJournal journal = new UpdateJournal(phase, "source", "target", "a".repeat(64), "boot");
            check(journal.isUnapplied() == (phase == UpdateJournal.Phase.DOWNLOADING
                    || phase == UpdateJournal.Phase.VERIFIED), "Unexpected extraction ownership: " + phase);
        }
        if (mode.equals("refuse")) {
            try { PackageVerifier.reclaimExtractionScratch(root); }
            catch (IOException refused) { System.out.println("refused"); return; }
            throw new AssertionError("Unrecognized scratch accepted");
        }
        if (mode.equals("refuse-final")) {
            try { PackageVerifier.hasRetainedPayload(root.resolve("candidate.payload").toFile()); }
            catch (IOException refused) { System.out.println("refused final"); return; }
            throw new AssertionError("Unrecognized final pathname accepted");
        }
        Path zipPath = root.resolve("fixture.zip");
        if (!Files.exists(zipPath)) {
            try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(zipPath))) {
                zip.putNextEntry(new ZipEntry("payload.bin"));
                zip.write(PAYLOAD);
                zip.closeEntry();
            }
        }
        Path destination = root.resolve("candidate.payload");
        if (mode.startsWith("fault:")) {
            String[] fault = mode.split(":", 4);
            replayFailure(root, zipPath, destination, fault[1] + ":" + fault[2], Integer.parseInt(fault[3]));
            return;
        }
        if (mode.startsWith("interrupt:")) {
            replayFailure(root, zipPath, destination, mode.substring("interrupt:".length()) + ":payload.partial", null);
            return;
        }
        Path partial;
        if (mode.equals("legacy-cut")) {
            partial = java.io.File.createTempFile("payload-", ".partial", root.toFile()).toPath();
        } else {
            partial = PackageVerifier.reclaimExtractionScratch(root);
            check(!Files.exists(partial), "Stale scratch was not reclaimed");
            partial = PackageVerifier.createExtractionScratch(partial);
        }
        Path extraction = partial;
        try (ZipFile zip = new ZipFile(zipPath.toFile()) {
            @Override public InputStream getInputStream(ZipEntry entry) throws IOException {
                InputStream input = super.getInputStream(entry);
                if (mode.equals("publish")) return input;
                return new FilterInputStream(input) {
                    @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                        if (Files.size(extraction) > 0) Runtime.getRuntime().halt(73);
                        return super.read(buffer, offset, Math.min(length, 4096));
                    }
                };
            }
        }) {
            String digest = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(PAYLOAD));
            PackageVerifier.extractPayload(zip, zip.getEntry("payload.bin"), partial,
                    destination, PAYLOAD.length, digest);
        }
        check(mode.equals("publish"), "Expected abrupt termination before publish");
        check(MessageDigest.isEqual(PAYLOAD, Files.readAllBytes(destination)), "Published bytes differ");
        check(!Files.exists(partial), "Scratch remained after publish");
        System.out.println("published");
    }
    private static void replayFailure(Path root, Path zipPath, Path destination, String operation, Integer errno)
            throws Exception {
        Path partial = PackageVerifier.reclaimExtractionScratch(root);
        byte[] archive = Files.readAllBytes(zipPath);
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        String archiveHash = HexFormat.of().formatHex(hash.digest(archive));
        String digest = Base64.getEncoder().encodeToString(hash.digest(PAYLOAD));
        boolean interruption = errno == null;
        boolean deferred = !interruption && (errno == OsConstants.ENOSPC || errno == OsConstants.EDQUOT);
        boolean mayRetry = interruption || deferred;
        Path held = root.resolve("b".repeat(64) + ".payload");
        Files.write(held, PAYLOAD);
        var context = new StorageReplay.Context(root);
        StorageReplay.JournalStore.context = context;
        var store = new StorageReplay.JournalStore(root.toFile());
        UpdateJournal initial = UpdateJournal.idle().download("source", "target", archiveHash);
        if (operation.equals("fsync:payload.partial")) initial = initial.verified("source", "target", archiveHash);
        store.seed(initial);
        byte[] journal = Files.readAllBytes(store.path);
        var runner = new UpdateRunner(context);
        var run = new StorageReplay.Run(context);
        runner.active = run;

        if (interruption) Os.interruptAfter(operation, PAYLOAD.length);
        else Os.failNext(operation, errno);
        int payloadSyncs;
        try (ZipFile zip = new ZipFile(zipPath.toFile())) {
            try {
                PackageVerifier.createExtractionScratch(partial);
                PackageVerifier.extractPayload(zip, zip.getEntry("payload.bin"), partial,
                        destination, PAYLOAD.length, digest);
                throw new AssertionError("Expected the injected scratch failure");
            } catch (IOException failure) {
                check((failure instanceof PackageVerifier.StorageDeferred) == deferred,
                        "Incorrect scratch classification");
                if (interruption) {
                    check(Thread.currentThread().isInterrupted() && "OTA verification cancelled".equals(failure.getMessage()),
                            "The interrupted extraction must keep its flag and report cancellation");
                    check(runner.stop(run.job) && run.task.isCancelled(), "The stopped run kept ownership");
                    Thread.interrupted(); // The fixture starts a separate attempt below.
                } else {
                    check(failure.getCause() instanceof ErrnoException cause && cause.errno == errno,
                            "Original errno was lost");
                }
                runner.report(run, failure);
            }
            payloadSyncs = Os.payloadSyncs();
            check(!Files.exists(partial) && !Files.exists(destination), "Failed scratch was published or retained");
            check(MessageDigest.isEqual(archive, Files.readAllBytes(zipPath)), "Retained archive changed");
            check(MessageDigest.isEqual(PAYLOAD, Files.readAllBytes(held)), "Held payload changed");
            check(context.posts == (interruption ? 0 : 1) && context.finishes == context.posts
                            && context.schedules == 0 && runner.active == null,
                    "Scratch failure completed or scheduled the wrong run");
            UpdateJournal.Phase expected = mayRetry ? initial.phase : UpdateJournal.Phase.FAILED;
            check(store.read().phase == expected && context.writes == (mayRetry ? 0 : 1),
                    "Scratch failure changed the wrong journal state");
            if (mayRetry) {
                check(MessageDigest.isEqual(journal, Files.readAllBytes(store.path)), "Retryable failure changed the journal");
                PackageVerifier.createExtractionScratch(PackageVerifier.reclaimExtractionScratch(root));
                PackageVerifier.extractPayload(zip, zip.getEntry("payload.bin"), partial,
                        destination, PAYLOAD.length, digest);
                check(MessageDigest.isEqual(PAYLOAD, Files.readAllBytes(destination)), "Retry changed the payload");
                check(!Files.exists(partial), "Scratch remained after retry");
                check(MessageDigest.isEqual(journal, Files.readAllBytes(store.path))
                                && MessageDigest.isEqual(archive, Files.readAllBytes(zipPath))
                                && MessageDigest.isEqual(PAYLOAD, Files.readAllBytes(held)),
                        "Scratch retry changed preserved state");
            }
        }
        System.out.printf("{\"initialPhase\":\"%s\",\"phase\":\"%s\",\"journalWrites\":%d,\"retryPublished\":%b,\"payloadSyncs\":%d}%n",
                initial.phase, store.read().phase, context.writes, Files.exists(destination), payloadSyncs);
    }
}
