package ai.elizaos.app;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/** Lost real synthetic HTTP acknowledgement -> journal restart -> identical receipt retry, no redispatch. */
public final class ClockHostReceiptTest {
    private static int checks;
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
    private static void sync(Path directory) throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); }
    }
    public static void main(String[] args) throws Exception {
        Path parent = Files.createTempDirectory("eliza-clock-receipt-").toRealPath();
        AtomicInteger effects = new AtomicInteger(), posts = new AtomicInteger();
        AtomicReference<String> accepted = new AtomicReference<>();
        HttpServer fixture = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fixture.createContext("/api/client-devices/proposals/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (posts.incrementAndGet() == 1) { accepted.set(body); exchange.close(); return; }
            if (!body.equals(accepted.get())) throw new AssertionError("Receipt retry changed claim or outcome");
            byte[] data = "{\"settled\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, data.length); exchange.getResponseBody().write(data); exchange.close();
        });
        fixture.start();
        try {
            for (boolean owned : List.of(false, true)) {
                effects.set(0); posts.set(0); accepted.set(null);
                String proposalId = owned ? "12345678-1234-1234-1234-123456789abc" : "proposal";
                JSONObject context = new JSONObject().put("agentId", "agent").put("subjectUserId", "owner").put("installationId", "installation")
                        .put("enrollmentId", "enrollment").put("scope", "a".repeat(64));
                JSONObject raw = new JSONObject().put("id", proposalId).put("digest", "b".repeat(64)).put("state", "executing")
                        .put("subjectUserId", "owner").put("expiresAt", Instant.now().plusSeconds(300).toString())
                        .put("resolvedBy", "owner").put("resolutionReason", "Explicit device review:" + "b".repeat(64))
                        .put("payload", new JSONObject().put("action", "device_action").put("version", 1).put("installationId", "installation")
                                .put("enrollmentId", "enrollment").put("operation", new JSONObject().put("type", owned ? "clock_alarm" : "clock_handoff").put("action", "set")
                                        .put("hour", 9).put("minute", 0).put("label", "Daily").put("timeZone", "UTC").put("days", new JSONArray(List.of(1, 2, 3, 4, 5, 6, 7)))))
                        .put("execution", new JSONObject().put("attemptId", "attempt").put("dispatchStartedAt", Instant.now().toString()));
                if (owned) raw.getJSONObject("payload").put("clockContextRevision", 12L);
                ClockHostClient.Proposal proposal = new ClockHostClient.Proposal(raw, context);
                ClockConsentCoordinator.ApprovedEntry approved = ClockHostClient.admitted(context, proposal, "native-owner");
                Path directory = parent.resolve(owned ? "owned-journal" : "journal");
                ClockConsentCoordinator first = new ClockConsentCoordinator(directory, "native-owner", identity -> approved, ClockHostReceiptTest::sync, () -> 1000);
                first.reviewClock(approved.identity, approved.request); String token = first.approveFromNativeGesture(approved.identity, approved.request);
                String effectReceipt = owned ? new JSONObject().put("kind", "clock-alarm").put("action", "set").put("status", "scheduled")
                        .put("alarmId", proposalId).put("nextAt", 1791378000000L).toString() : null;
                ClockConsentCoordinator.Result nativeOutcome = first.confirmClock(approved.identity, token, new ClockConsentCoordinator.Dispatcher() {
                    @Override public ClockHandoff.Outcome dispatch(ClockHandoff.Request request, ClockHandoff.ApprovedConsent consume) {
                        consume.consume(request); effects.incrementAndGet(); return owned ? ClockHandoff.Outcome.APPLIED : ClockHandoff.Outcome.OPENED;
                    }
                    @Override public String receipt() { return effectReceipt; }
                });
                String body = ClockHostReceipts.body(proposal, approved.identity, nativeOutcome, effectReceipt).toString();
                URI endpoint = URI.create("http://127.0.0.1:" + fixture.getAddress().getPort() + "/api/client-devices/proposals/" + proposalId + "/receipt");
                try { ClockHostHttp.request(endpoint, "POST", body, Map.of("Content-Type", "application/json"), () -> {}, null); throw new AssertionError("Lost receipt fabricated HTTP success"); }
                catch (IOException expected) { checks++; }
                check(posts.get() == 1 && accepted.get().equals(body), "Mutation POST must not automatically retry after a lost acknowledgement");
                ClockConsentCoordinator restarted = new ClockConsentCoordinator(directory, "native-owner", identity -> approved, ClockHostReceiptTest::sync, () -> 1000);
                ClockConsentCoordinator.Result saved = restarted.reconcileClock(approved.identity, approved.request).result;
                check(saved == (owned ? ClockConsentCoordinator.Result.APPLIED : ClockConsentCoordinator.Result.OPENED), "Persisted receipt must survive lost HTTP and process restart");
                String retained = owned ? restarted.effectReceipt(approved.identity) : null;
                check(java.util.Objects.equals(retained, effectReceipt), "V3 must preserve typed alarm evidence across lost acknowledgement");
                String retried = ClockHostReceipts.body(proposal, approved.identity, saved, retained).toString();
                check(retried.equals(body), "Saved-outcome retry must retain digest, attempt, operation and result exactly");
                check(ClockHostHttp.request(endpoint, "POST", retried, Map.of("Content-Type", "application/json"), () -> {}, null).status == 200,
                        "Explicit receipt reconciliation must settle the same server claim");
                check(restarted.confirmClock(approved.identity, token, (request, consume) -> {
                    consume.consume(request); effects.incrementAndGet(); return ClockHandoff.Outcome.OPENED;
                }) == (owned ? ClockConsentCoordinator.Result.APPLIED : ClockConsentCoordinator.Result.OPENED) && effects.get() == 1 && posts.get() == 2, "Receipt recovery must never launch another native effect");
                if (owned) {
                    for (JSONObject invalid : List.of(new JSONObject(effectReceipt).put("status", "opened"),
                            new JSONObject(effectReceipt).put("alarmId", "87654321-1234-1234-1234-123456789abc"),
                            new JSONObject(effectReceipt).put("nextAt", JSONObject.NULL),
                            new JSONObject(effectReceipt).put("nextAt", 1791378000000.5),
                            new JSONObject(effectReceipt).put("alarmCreated", true))) {
                        try { ClockHostReceipts.result(proposal.request, saved, invalid.toString(), proposalId); throw new AssertionError("Invalid native alarm evidence accepted"); }
                        catch (SecurityException | IllegalArgumentException expected) { checks++; }
                    }
                    check("unknown".equals(ClockHostReceipts.result(proposal.request, ClockConsentCoordinator.Result.UNKNOWN).getString("status")),
                            "Unknown native alarm evidence must remain explicit");
                }
            }
        } finally {
            fixture.stop(0);
            try (var paths = Files.walk(parent)) { for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path); }
        }
        System.out.println("Native Clock lost-receipt recovery passed: " + checks + " checks; synthetic HTTP and journal only, no Android effect");
    }
}
