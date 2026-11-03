package ai.eliza.plugins.agent.connection.test;

import ai.eliza.plugins.agent.runtime.CredentialIntentFence;
import ai.eliza.plugins.agent.runtime.CredentialRequestFence;
import ai.eliza.plugins.agent.runtime.NativeProviderAdmission;
import ai.eliza.plugins.agent.runtime.NativeProviderSlot;
import ai.eliza.voice.CartesiaSpeech;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/** Offline contracts for explicit owner credentials, leases and fixed speech transport. */
public final class OwnerProviderTest {
  interface Action { void run() throws Exception; }
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }
  private static void refused(Action action, String message) throws Exception {
    try { action.run(); } catch (Exception expected) { return; }
    throw new AssertionError(message);
  }
  private static final String KEY = "test-owner-provider-key", SPEECH = "test-owner-speech-key";
  private static final class Connection extends HttpURLConnection {
    byte[] response;
    final ByteArrayOutputStream body = new ByteArrayOutputStream();
    boolean closed;
    int status = 200;
    Connection(URL url, byte[] response) { super(url); this.response = response; }
    public void disconnect() { closed = true; }
    public boolean usingProxy() { return false; }
    public void connect() {}
    public int getResponseCode() { return status; }
    public InputStream getInputStream() { return new ByteArrayInputStream(response); }
    public OutputStream getOutputStream() { return body; }
  }
  public static void main(String[] args) throws Exception {
    Object lock = new Object();
    CredentialIntentFence intents = new CredentialIntentFence();
    AtomicLong time = new AtomicLong(0);
    CredentialRequestFence leases = new CredentialRequestFence(lock, intents, time::get);
    String first = leases.reserve();
    long intent = leases.begin(first);
    leases.require(first, intent);
    refused(() -> leases.begin(first), "a lease must begin once");
    leases.cancel("unknown");
    leases.require(first, intent);
    leases.cancel(first);
    refused(() -> leases.require(first, intent), "cancellation must retire a begun lease");
    String stale = leases.reserve();
    String current = leases.reserve();
    refused(() -> leases.begin(stale), "a new owner intent supersedes an older lease");
    long active = leases.begin(current);
    leases.finish(current, active);
    refused(() -> leases.require(current, active), "finished leases must be unavailable");
    String expired = leases.reserve();
    time.set(120_000_000_000L);
    refused(() -> leases.begin(expired), "lease expiry must refuse mutation");
    for (int i = 0; i < 64; i++) leases.reserve();
    refused(leases::reserve, "unbounded lease admission");
    time.addAndGet(120_000_000_000L);
    leases.begin(leases.reserve());

    ResidentLifecycleTest.Slot slot = new ResidentLifecycleTest.Slot();
    String credentialId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    String userId = "3b241101-e2bb-4255-8caf-4136c566a962";
    String organizationId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
    String cloud = new JSONObject().put("credentialId", credentialId).put("token", "eliza_test_token_not_a_secret_0123456789").put("userId", userId).put("organizationId", organizationId).toString();
    slot.value = NativeProviderAdmission.admit(null, new JSONObject().put("provider", "elizacloud").put("credentialId", credentialId).put("model", NativeProviderAdmission.CLOUD_PROVIDER_MODEL).toString(), cloud, new JSONObject().put("userId", userId).put("organizationId", organizationId));
    check(NativeProviderSlot.saveVerifiedProvider(slot, KEY, NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL, SPEECH, (key, model) -> null, "Product") == null, "owner credentials must save");
    JSONObject saved = new JSONObject(slot.value);
    check(SPEECH.equals(saved.getString("cartesiaKey")), "speech credential must survive storage");
    check(credentialId.equals(saved.getJSONObject("cloudServices").getString("credentialId")), "direct choice must retain account services");
    JSONObject identity = NativeProviderAdmission.providerIdentity(slot.value);
    check(identity.getBoolean("selected") && identity.getBoolean("voiceConfigured"), "identity must expose capability facts");
    check(!identity.toString().contains(KEY) && !identity.toString().contains(SPEECH), "identity cannot disclose credentials");
    slot.value = NativeProviderAdmission.admit(null, slot.value, null, null);
    String generation = NativeProviderAdmission.currentGeneration(slot.value, null);
    JSONObject binding = NativeProviderAdmission.managedGoogleBinding(slot.value, cloud, System.currentTimeMillis());
    check(organizationId.equals(binding.getString("organizationId")) && generation.equals(binding.getString("sessionGeneration")), "retained services use verified account and current direct generation");
    String foreignCloud = new JSONObject(cloud).put("credentialId", "7c9e6679-7425-40de-944b-e07fc1f90ae7").toString();
    refused(() -> NativeProviderAdmission.managedGoogleBinding(slot.value, foreignCloud, System.currentTimeMillis()), "foreign retained account must be rejected");
    NativeProviderSlot.Store lostSpeech = new NativeProviderSlot.Store() {
      public String readProvider() { return new JSONObject(slot.value).put("cartesiaKey", (Object)null).toString(); }
      public void assertCurrent() {}
      public String compareExchangeProvider(String previous, String selection) { slot.value = selection; return selection; }
      public void removeProvider(boolean onlyIfPresent) {}
    };
    refused(() -> NativeProviderSlot.saveVerifiedProvider(lostSpeech, KEY, NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL, SPEECH, (key, model) -> null, "Product"), "lost speech credential must not report a successful save");
    HashMap<String, String> env = new HashMap<>();
    env.put("OPENAI_API_KEY", "stale");
    env.put("CARTESIA_API_KEY_FILE", "stale");
    NativeProviderAdmission.applyProviderEnvironment(saved, null, env, 0);
    check(SPEECH.equals(env.get("CARTESIA_API_KEY")) && "1".equals(env.get("ELIZA_SELF_HOSTED_VOICE_ENABLED")), "voice opt-in must bind its exact key");
    check(!env.containsKey("OPENAI_API_KEY") && !env.containsKey("CARTESIA_API_KEY_FILE"), "stale alternate keys must be removed");
    NativeProviderSlot.bindDirectProvider(slot, KEY, NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL);
    check(!NativeProviderAdmission.providerIdentity(slot.value).getBoolean("voiceConfigured"), "omitting speech turns voice off");
    slot.value = NativeProviderAdmission.admit(null, slot.value, null, null);
    check(!generation.equals(NativeProviderAdmission.currentGeneration(slot.value, null)), "credential changes must retire the generation");
    NativeProviderAdmission.applyProviderEnvironment(new JSONObject(slot.value), null, env, 0);
    check(!env.containsKey("CARTESIA_API_KEY") && !env.containsKey("ELIZA_SELF_HOSTED_VOICE_ENABLED"), "voice-off launch cannot inherit a speech key");

    byte[] wav = new byte[44];
    System.arraycopy("RIFF".getBytes(StandardCharsets.US_ASCII), 0, wav, 0, 4);
    System.arraycopy("WAVE".getBytes(StandardCharsets.US_ASCII), 0, wav, 8, 4);
    Connection[] last = new Connection[1];
    CartesiaSpeech.Connections connections = url -> last[0] = new Connection(url, "{\"text\":\"hello\"}".getBytes(StandardCharsets.UTF_8));
    AtomicInteger checks = new AtomicInteger();
    CartesiaSpeech.Guard guard = new CartesiaSpeech.Guard() {
      public void check() { checks.incrementAndGet(); }
      public void opened(HttpURLConnection connection) {}
    };
    check("hello".equals(CartesiaSpeech.transcribe(SPEECH, wav, guard, connections)), "transcription response");
    check(last[0].getURL().toString().equals("https://api.cartesia.ai/stt") && !last[0].getInstanceFollowRedirects() && last[0].closed, "fixed nonredirecting transport closes");
    check(last[0].body.toString("UTF-8").contains("ink-whisper"), "transcription model");
    check(checks.get() > 3, "transport must check cancellation throughout");
    byte[] synthesized = CartesiaSpeech.synthesize(SPEECH, "Hello", guard, url -> last[0] = new Connection(url, wav));
    check(synthesized.length == 44 && last[0].closed, "synthesis returns validated WAV and closes");
    check(new JSONObject(last[0].body.toString("UTF-8")).getString("transcript").equals("Hello"), "speech must preserve text");
    refused(() -> CartesiaSpeech.synthesize(SPEECH, "Hello", guard, url -> last[0] = new Connection(url, new byte[44])), "malformed audio cannot succeed");
    refused(() -> CartesiaSpeech.transcribe(SPEECH, wav, guard, url -> {
      Connection failure = new Connection(url, new byte[0]); failure.status = 401; last[0] = failure; return failure;
    }), "HTTP failure cannot fabricate transcript");
    check(last[0].closed, "HTTP failure closes connection");
    CartesiaSpeech.Guard cancelled = new CartesiaSpeech.Guard() {
      public void check() throws Exception { throw new InterruptedException(); }
      public void opened(HttpURLConnection connection) {}
    };
    refused(() -> CartesiaSpeech.synthesize(SPEECH, "Hello", cancelled, url -> { throw new AssertionError("cancelled request opened network"); }), "cancelled speech cannot open transport");
    refused(() -> CartesiaSpeech.synthesize("bad key", "Hello", guard, connections), "invalid credential refused");
    refused(() -> CartesiaSpeech.synthesize(SPEECH, "x".repeat(5001), guard, connections), "oversized speech must be explicitly rejected");
    System.out.println("PASS owner provider leases, credential isolation and speech transport");
  }
}
