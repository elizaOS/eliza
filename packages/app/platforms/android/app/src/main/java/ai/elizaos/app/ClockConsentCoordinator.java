/**
 * Persists native Clock consent and dispatch receipts alongside trusted server proposals.
 * This journal never creates an approval: the host supplies an authoritative admitted
 * proposal lookup and a native owner binding. A consumed consent survives process death
 * as unknown until a receipt is saved, so losing a response cannot replay an intent.
 * I/O budget: one capped 16 KiB entry per proposal; each review/consent reads once
 * and writes at most once, while confirm reads once and writes at most twice.
 * All work is demand-driven, with no polling or network calls under the file lock.
 */
package ai.elizaos.app;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

final class ClockConsentCoordinator {
    enum Result { OPENED, APPLIED, UNAVAILABLE, DENIED, UNKNOWN }
    private enum Phase { REVIEW, CONSENT, DISPATCHED, COMPLETE, CANCELLED }

    static final class Identity {
        final String scope, proposalId, operationId;
        Identity(String scope, String proposalId, String operationId) {
            if (scope == null || !scope.matches("[a-f0-9]{64}"))
                throw new IllegalArgumentException("Invalid Clock scope");
            this.scope = scope;
            this.proposalId = identifier(proposalId);
            this.operationId = identifier(operationId);
        }
    }

    /** Construct only from the server's owner/enrollment/digest-bound execution claim.
     * Lookup must reject revoked, expired or mismatched claims and stale native owners;
     * renderer fields and a pending proposal are never authority. Keep completed claims
     * readable for receipt reconciliation without granting another execution attempt. */
    static final class ApprovedEntry {
        final Identity identity;
        final ClockHandoff.Request request;
        final String owner, claimDigest;
        ApprovedEntry(Identity identity, ClockHandoff.Request request, String owner, String claimDigest) {
            this.identity = Objects.requireNonNull(identity);
            this.request = Objects.requireNonNull(request);
            this.owner = identifier(owner);
            if (claimDigest == null || !claimDigest.matches("[a-f0-9]{64}"))
                throw new IllegalArgumentException("Invalid Clock claim digest");
            this.claimDigest = claimDigest;
        }
    }

    /** Use the host's locally retained authenticated claim; no network I/O while journal-locked. */
    interface ApprovedLookup { ApprovedEntry requireApproved(Identity identity) throws IOException; }
    interface DirectorySync { void sync(Path directory) throws IOException; }
    /** Synchronous native launch only; consume immediately before its first external effect. */
    interface Dispatcher {
        ClockHandoff.Outcome dispatch(ClockHandoff.Request request, ClockHandoff.ApprovedConsent consent);
        default String receipt() { return null; }
    }
    static final class Review {
        final ClockHandoff.Request request;
        final Result result;
        Review(ClockHandoff.Request request, Result result) { this.request = request; this.result = result; }
    }
    private static final class Entry {
        int magic = MAGIC_V2;
        ApprovedEntry approved;
        Phase phase;
        String tokenHash = "";
        long issued, expires;
        Result result;
        String effectReceipt = "";
    }
    private interface Locked<T> { T run() throws IOException; }
    private static final ConcurrentHashMap<Path, Object> LOCKS = new ConcurrentHashMap<>();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int MAGIC_V1 = 0x434c4b31, MAGIC_V2 = 0x434c4b32, MAGIC_V3 = 0x434c4b33, MAX_BYTES = 16384;
    private static final long CONSENT_MILLIS = 120000;
    private final Path directory;
    private final String owner;
    private final ApprovedLookup authority;
    private final DirectorySync durability;
    private final LongSupplier now;

    ClockConsentCoordinator(Path directory, String owner, ApprovedLookup authority,
                            DirectorySync durability, LongSupplier now) throws IOException {
        this.directory = directory.toAbsolutePath().normalize();
        this.owner = identifier(owner);
        this.authority = Objects.requireNonNull(authority);
        this.durability = Objects.requireNonNull(durability);
        this.now = Objects.requireNonNull(now);
        if (!Files.exists(this.directory, LinkOption.NOFOLLOW_LINKS)) {
            Files.createDirectory(this.directory);
            durability.sync(this.directory.getParent());
        }
        if (!Files.isDirectory(this.directory, LinkOption.NOFOLLOW_LINKS)
                || !this.directory.toRealPath().equals(this.directory))
            throw new IOException("Clock storage must be native private storage without symlinks");
    }

    /** Prepares exact approved fields for a native dialog; no consent token is minted here. */
    Review reviewClock(Identity identity, ClockHandoff.Request request) throws IOException {
        return locked(() -> {
            ApprovedEntry approved = approved(identity, request);
            Entry entry = read(identity);
            if (entry == null) {
                entry = new Entry(); entry.approved = approved; entry.phase = Phase.REVIEW;
                if (request.owned) entry.magic = MAGIC_V3;
                write(entry);
            } else requireBinding(entry, approved);
            return new Review(approved.request, outcome(entry));
        });
    }

    /** A server claim alone cannot create or replace native consent after a lost response/restart. */
    Review reconcileClock(Identity identity, ClockHandoff.Request request) throws IOException {
        return locked(() -> {
            Entry entry = required(identity);
            requireBinding(entry, approved(identity, request));
            return new Review(entry.approved.request, outcome(entry));
        });
    }

    /** Native positive-button callbacks alone call this method; never expose it as IPC. */
    String approveFromNativeGesture(Identity identity, ClockHandoff.Request request) throws IOException {
        return locked(() -> {
            ApprovedEntry approved = approved(identity, request);
            Entry entry = required(identity); requireBinding(entry, approved);
            if (entry.phase != Phase.REVIEW && entry.phase != Phase.CONSENT)
                throw new SecurityException("Clock review cannot grant consent");
            byte[] entropy = new byte[32]; RANDOM.nextBytes(entropy);
            String token = hex(entropy);
            entry.phase = Phase.CONSENT; entry.tokenHash = hex(hash(token.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            entry.issued = now.getAsLong();
            if (entry.issued < 0 || entry.issued > Long.MAX_VALUE - CONSENT_MILLIS)
                throw new IOException("Invalid native consent clock");
            entry.expires = entry.issued + CONSENT_MILLIS;
            write(entry);
            return token;
        });
    }

    Result confirmClock(Identity identity, String token, Dispatcher dispatcher) throws IOException {
        Objects.requireNonNull(dispatcher);
        return locked(() -> {
            Entry entry = required(identity);
            requireBinding(entry, approved(identity, entry.approved.request));
            if (token == null || !token.matches("[a-f0-9]{64}") || entry.tokenHash.isEmpty()
                    || !MessageDigest.isEqual(hash(token.getBytes(java.nio.charset.StandardCharsets.UTF_8)), unhex(entry.tokenHash)))
                throw new SecurityException("Clock consent token does not match");
            Result previous = outcome(entry);
            if (previous != null) return previous;
            long current = now.getAsLong();
            if (entry.phase != Phase.CONSENT || current < entry.issued || current >= entry.expires)
                throw new SecurityException("Clock native consent expired or unavailable");
            return dispatch(identity, entry, Phase.CONSENT, dispatcher);
        });
    }

    /** Authenticated active ringing control is an explicit native policy, not a manufactured gesture.
     * The host must fence current owner, revision and active occurrence inside dispatch before consume.
     * A pre-existing review, cancellation or consumed entry cannot gain fresh authority here. */
    Result controlActiveAlarm(Identity identity, ClockHandoff.Request request, Dispatcher dispatcher) throws IOException {
        Objects.requireNonNull(dispatcher);
        if (!request.owned || (request.action != ClockHandoff.Action.DISMISS && request.action != ClockHandoff.Action.SNOOZE))
            throw new SecurityException("Immediate policy only controls a ringing owned alarm");
        return locked(() -> {
            ApprovedEntry admitted = approved(identity, request);
            Entry entry = read(identity);
            if (entry != null) {
                requireBinding(entry, admitted);
                Result previous = outcome(entry);
                if (previous != null) return previous;
                throw new SecurityException("Existing Clock review cannot gain immediate authority");
            }
            entry = new Entry(); entry.magic = MAGIC_V3; entry.approved = admitted; entry.phase = Phase.REVIEW;
            write(entry);
            return dispatch(identity, entry, Phase.REVIEW, dispatcher);
        });
    }

    private Result dispatch(Identity identity, Entry entry, Phase authorization, Dispatcher dispatcher) throws IOException {
        ClockHandoff.ApprovedConsent consume = request -> {
            if (entry.phase != authorization || !sameRequest(request, entry.approved.request))
                throw new SecurityException("Clock dispatch consent changed");
            try {
                requireBinding(entry, approved(identity, request));
                if (authorization == Phase.CONSENT) {
                    long instant = now.getAsLong();
                    if (instant < entry.issued || instant >= entry.expires)
                        throw new SecurityException("Clock native consent expired");
                }
                entry.phase = Phase.DISPATCHED;
                write(entry);
            } catch (IOException error) {
                // error-policy:J2 the synchronous dispatcher cannot proceed without durable consent.
                throw new java.io.UncheckedIOException("Clock consent durability failed", error);
            }
        };
        try {
            ClockHandoff.Outcome dispatched = Objects.requireNonNull(dispatcher.dispatch(entry.approved.request, consume));
            if (dispatched != ClockHandoff.Outcome.UNAVAILABLE && entry.phase != Phase.DISPATCHED)
                throw new IllegalStateException("Clock dispatcher did not consume native consent");
            if (dispatched == ClockHandoff.Outcome.UNAVAILABLE && entry.phase == Phase.DISPATCHED)
                throw new IllegalStateException("Consumed Clock dispatch cannot establish unavailable");
            if (dispatched == ClockHandoff.Outcome.APPLIED) {
                if (!entry.approved.request.owned) throw new IllegalStateException("Legacy handoff cannot prove an owned alarm effect");
                entry.effectReceipt = Objects.requireNonNull(dispatcher.receipt());
                if (entry.effectReceipt.isEmpty()) throw new IllegalStateException("Owned alarm effect receipt missing");
            }
            entry.result = dispatched == ClockHandoff.Outcome.APPLIED ? Result.APPLIED
                    : dispatched == ClockHandoff.Outcome.OPENED ? Result.OPENED : Result.UNAVAILABLE;
            entry.phase = Phase.COMPLETE;
            write(entry);
            return entry.result;
        } catch (RuntimeException error) {
            // error-policy:J1 dispatch boundary: a persisted marker cannot establish launch or permit replay.
            if (entry.phase != Phase.DISPATCHED) throw error;
            entry.effectReceipt = ""; entry.result = Result.UNKNOWN; entry.phase = Phase.COMPLETE;
            write(entry);
            return Result.UNKNOWN;
        }

    }

    /** Read the already committed native effect receipt; never re-run scheduling to reconstruct it. */
    String effectReceipt(Identity identity) throws IOException {
        return locked(() -> {
            Entry entry = required(identity);
            requireBinding(entry, approved(identity, entry.approved.request));
            return entry.result == Result.APPLIED ? entry.effectReceipt : null;
        });
    }

    /** Retirement may cancel after server authority disappears, but only for the original native owner. */
    void cancelClock(Identity identity) throws IOException {
        locked(() -> {
            Entry entry = read(identity);
            if (entry == null) return null;
            requireIdentity(entry.approved.identity, identity);
            if (!owner.equals(entry.approved.owner)) throw new SecurityException("Clock native owner changed");
            if (entry.phase == Phase.REVIEW || entry.phase == Phase.CONSENT) {
                entry.phase = Phase.CANCELLED; write(entry);
            } else if (entry.phase == Phase.CANCELLED) durability.sync(directory);
            return null;
        });
    }

    private ApprovedEntry approved(Identity identity, ClockHandoff.Request request) throws IOException {
        ApprovedEntry approved = Objects.requireNonNull(authority.requireApproved(identity));
        requireIdentity(approved.identity, identity);
        if (!owner.equals(approved.owner) || !sameRequest(approved.request, request))
            throw new SecurityException("Clock approval owner or request changed");
        return approved;
    }
    private static Result outcome(Entry entry) {
        if (entry.phase == Phase.CANCELLED) return Result.DENIED;
        if (entry.phase == Phase.DISPATCHED) return Result.UNKNOWN;
        return entry.result;
    }
    private static void requireBinding(Entry entry, ApprovedEntry approved) {
        requireIdentity(entry.approved.identity, approved.identity);
        if (!entry.approved.owner.equals(approved.owner) || !entry.approved.claimDigest.equals(approved.claimDigest)
                || !sameRequest(entry.approved.request, approved.request))
            throw new SecurityException("Clock approved claim changed");
    }
    private static void requireIdentity(Identity a, Identity b) {
        if (!a.scope.equals(b.scope) || !a.proposalId.equals(b.proposalId) || !a.operationId.equals(b.operationId))
            throw new SecurityException("Clock journal identity changed");
    }
    private static boolean sameRequest(ClockHandoff.Request a, ClockHandoff.Request b) {
        return a.action == b.action && a.hour == b.hour && a.minute == b.minute && a.snoozeMinutes == b.snoozeMinutes
                && Objects.equals(a.label, b.label) && Objects.equals(a.timeZone, b.timeZone)
                && Objects.equals(a.days, b.days) && a.owned == b.owned
                && Objects.equals(a.alarmId, b.alarmId) && a.enabled == b.enabled;
    }
    private <T> T locked(Locked<T> action) throws IOException {
        synchronized (LOCKS.computeIfAbsent(directory, ignored -> new Object())) {
            Path lock = directory.resolve("lock");
            if (Files.isSymbolicLink(lock)) throw new IOException("Invalid Clock lock");
            try (FileChannel channel = FileChannel.open(lock, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                 FileLock held = channel.lock()) {
                if (!held.isValid()) throw new IOException("Clock journal lock unavailable");
                return action.run();
            }
        }
    }
    private Path path(Identity identity) {
        return directory.resolve(hex(hash((identity.scope + ":" + identity.proposalId).getBytes(java.nio.charset.StandardCharsets.UTF_8))));
    }
    private Entry required(Identity identity) throws IOException {
        Entry entry = read(identity);
        if (entry == null) throw new SecurityException("Clock native review unavailable");
        requireIdentity(entry.approved.identity, identity);
        return entry;
    }
    private Entry read(Identity identity) throws IOException {
        Path file = path(identity);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return null;
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES)
            throw new IOException("Invalid Clock consent journal");
        byte[] bytes = Files.readAllBytes(file);
        if (bytes.length < 36) throw new IOException("Truncated Clock consent journal");
        byte[] payload = Arrays.copyOf(bytes, bytes.length - 32);
        if (!MessageDigest.isEqual(hash(payload), Arrays.copyOfRange(bytes, bytes.length - 32, bytes.length)))
            throw new IOException("Corrupt Clock consent journal");
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(payload))) {
            int magic = input.readInt();
            if (magic != MAGIC_V1 && magic != MAGIC_V2 && magic != MAGIC_V3) throw new IOException("Unsupported Clock consent journal");
            Entry entry = new Entry();
            // Keep legacy records in their original format, including consumed receipts.
            entry.magic = magic;
            Identity stored = new Identity(input.readUTF(), input.readUTF(), input.readUTF());
            String storedOwner = input.readUTF(), digest = input.readUTF();
            ClockHandoff.Action action = ClockHandoff.Action.valueOf(input.readUTF());
            ClockHandoff.Request request;
            switch (action) {
                case SET:
                case UPDATE:
                    int hour = input.readInt(), minute = input.readInt();
                    String label = input.readUTF(), timeZone = input.readUTF();
                    int count = magic != MAGIC_V1 ? input.readInt() : -1;
                    if (count < -1 || count > 7) throw new IOException("Invalid Clock repeat count");
                    if (count == -1) request = ClockHandoff.Request.set(hour, minute, label, timeZone);
                    else {
                        List<Integer> days = new ArrayList<>(count);
                        for (int day = 0; day < count; day++) days.add(input.readInt());
                        request = ClockHandoff.Request.set(hour, minute, label, timeZone, days);
                    }
                    if (action == ClockHandoff.Action.UPDATE) {
                        if (magic != MAGIC_V3) throw new IOException("Legacy Clock update unavailable");
                        // Target follows the schedule fields in the owned journal format.
                    }
                    break;
                case SNOOZE: request = ClockHandoff.Request.snooze(input.readInt()); break;
                case SHOW: request = ClockHandoff.Request.show(); break;
                case DISMISS: request = ClockHandoff.Request.dismiss(); break;
                case DELETE:
                case ENABLE:
                    if (magic != MAGIC_V3) throw new IOException("Legacy Clock management unavailable");
                    request = ClockHandoff.Request.show(); break;
                default: throw new IOException("Invalid Clock action");
            }
            if (magic == MAGIC_V3) {
                String target = input.readUTF(); boolean enabled = input.readBoolean();
                String alarmId = target.isEmpty() ? null : target;
                if (action == ClockHandoff.Action.UPDATE)
                    request = ClockHandoff.Request.update(request.hour, request.minute, request.label, request.timeZone, request.days, alarmId);
                else if (action == ClockHandoff.Action.DELETE) request = ClockHandoff.Request.delete(alarmId);
                else if (action == ClockHandoff.Action.ENABLE) request = ClockHandoff.Request.enable(alarmId, enabled);
                else request = ClockHandoff.Request.owned(request, alarmId, enabled);
            }
            entry.approved = new ApprovedEntry(stored, request, storedOwner, digest);
            entry.phase = Phase.valueOf(input.readUTF()); entry.tokenHash = input.readUTF();
            entry.issued = input.readLong(); entry.expires = input.readLong();
            String result = input.readUTF(); entry.result = result.isEmpty() ? null : Result.valueOf(result);
            if (magic == MAGIC_V3) entry.effectReceipt = input.readUTF();
            if (input.available() != 0 || (!entry.tokenHash.isEmpty() && !entry.tokenHash.matches("[a-f0-9]{64}"))
                    || entry.issued < 0 || entry.expires < entry.issued || entry.expires - entry.issued > CONSENT_MILLIS
                    || ((entry.phase == Phase.CONSENT || entry.phase == Phase.DISPATCHED) && entry.tokenHash.isEmpty())
                    || (entry.phase == Phase.COMPLETE) != (entry.result != null)
                    || (entry.result == Result.APPLIED) != !entry.effectReceipt.isEmpty())
                throw new IOException("Invalid Clock consent state");
            requireIdentity(stored, identity);
            return entry;
        } catch (IllegalArgumentException error) {
            // error-policy:J2 corrupt private data is a hard failure, never an empty journal.
            throw new IOException("Invalid Clock consent journal fields", error);
        }
    }
    private void write(Entry entry) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeInt(entry.magic);
            output.writeUTF(entry.approved.identity.scope); output.writeUTF(entry.approved.identity.proposalId); output.writeUTF(entry.approved.identity.operationId);
            output.writeUTF(entry.approved.owner); output.writeUTF(entry.approved.claimDigest);
            ClockHandoff.Request request = entry.approved.request; output.writeUTF(request.action.name());
            if (request.action == ClockHandoff.Action.SET || request.action == ClockHandoff.Action.UPDATE) {
                output.writeInt(request.hour); output.writeInt(request.minute); output.writeUTF(request.label); output.writeUTF(request.timeZone);
                if (entry.magic != MAGIC_V1) {
                    output.writeInt(request.days == null ? -1 : request.days.size());
                    if (request.days != null) for (int day : request.days) output.writeInt(day);
                } else if (request.days != null) throw new IOException("Legacy Clock consent cannot acquire repeat days");
            } else if (request.action == ClockHandoff.Action.SNOOZE) output.writeInt(request.snoozeMinutes);
            if (entry.magic == MAGIC_V3) {
                output.writeUTF(request.alarmId == null ? "" : request.alarmId); output.writeBoolean(request.enabled);
            }
            output.writeUTF(entry.phase.name()); output.writeUTF(entry.tokenHash); output.writeLong(entry.issued); output.writeLong(entry.expires);
            output.writeUTF(entry.result == null ? "" : entry.result.name());
            if (entry.magic == MAGIC_V3) output.writeUTF(entry.effectReceipt);
        }
        byte[] payload = bytes.toByteArray();
        if (payload.length + 32 > MAX_BYTES) throw new IOException("Clock consent entry exceeds I/O budget");
        Path temporary = Files.createTempFile(directory, "pending-", ".consent");
        try {
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                java.nio.ByteBuffer data = java.nio.ByteBuffer.wrap(payload);
                while (data.hasRemaining()) channel.write(data);
                data = java.nio.ByteBuffer.wrap(hash(payload)); while (data.hasRemaining()) channel.write(data);
                channel.force(true);
            }
            Files.move(temporary, path(entry.approved.identity), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            durability.sync(directory);
        } finally { Files.deleteIfExists(temporary); }
    }
    private static String identifier(String value) {
        if (value == null || !value.matches("[-A-Za-z0-9_]{1,128}")) throw new IllegalArgumentException("Invalid Clock identifier");
        return value;
    }
    private static byte[] hash(byte[] value) {
        try { return MessageDigest.getInstance("SHA-256").digest(value); }
        catch (NoSuchAlgorithmException error) {
            // error-policy:J2 SHA-256 is a required platform primitive.
            throw new IllegalStateException("SHA-256 unavailable", error);
        }
    }
    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(Character.forDigit((value >>> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
        return result.toString();
    }
    private static byte[] unhex(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int i = 0; i < result.length; i++) result[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return result;
    }
}
