package ai.eliza.plugins.messages.vvm;

import android.content.Context;

/**
 * Host identity of the visual-voicemail client, returned by both of the host's subclasses
 * ({@link VisualVoicemailClientService} and {@link VisualVoicemailReceiver}).
 */
public final class VvmConfiguration {
 public interface SecretsFactory { VvmSecrets open(Context context) throws Exception; }

 /** The host's declared {@link VisualVoicemailReceiver}: audio requests, sync requests and SMS send results go to it. */
 public final Class<? extends VisualVoicemailReceiver> receiver;
 /** {@link OmtpSms#V1_1} (the default), {@link OmtpSms#V1_2} or {@link OmtpSms#V1_3}; ignored for CVVM carriers. */
 public final String protocolVersion;
 /** The {@code ct} client type OMTP 1.2 and later send, as registered with the carrier; null for 1.1. */
 public final String clientType;
 public final SecretsFactory secrets;

 /** OMTP 1.1 requests and the Keystore-sealed account store ({@link KeystoreVvmSecrets}). */
 public VvmConfiguration(Class<? extends VisualVoicemailReceiver> receiver) { this(receiver, OmtpSms.V1_1, null, KeystoreVvmSecrets::new); }
 private VvmConfiguration(Class<? extends VisualVoicemailReceiver> receiver, String protocolVersion, String clientType, SecretsFactory secrets) {
  this.receiver = java.util.Objects.requireNonNull(receiver); this.secrets = java.util.Objects.requireNonNull(secrets);
  this.protocolVersion = protocolVersion; this.clientType = clientType;
  // Refuse an unusable identity when the host is built, not when the first SMS would be sent.
  OmtpSms.request("Activate", false, protocolVersion, clientType, 0, OmtpSms.DEFAULT_PREFIX);
 }
 /** Requests in OMTP 1.2 or 1.3 form with the client type the carrier knows this client by. */
 public VvmConfiguration withProtocol(String protocolVersion, String clientType) { return new VvmConfiguration(receiver, protocolVersion, clientType, secrets); }
 /** The host's own encrypted credential store instead of the default. */
 public VvmConfiguration withSecrets(SecretsFactory secrets) { return new VvmConfiguration(receiver, protocolVersion, clientType, secrets); }
}
