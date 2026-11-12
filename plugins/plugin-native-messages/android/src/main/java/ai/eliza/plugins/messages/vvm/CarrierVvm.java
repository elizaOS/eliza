package ai.eliza.plugins.messages.vvm;

import android.os.PersistableBundle;
import android.telephony.CarrierConfigManager;

import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * What the carrier configuration says about visual voicemail for one subscription, reduced to the
 * values this client acts on. {@link #from} answers null for everything this client does not speak:
 * no type, an unknown type (for example {@code vvm_type_vvm3}), legacy mode, or a configuration
 * without a usable destination number.
 */
public final class CarrierVvm {
 /** OMTP as the standard describes it, and the CVVM variant that differs only in its request text. */
 public static final String OMTP = "vvm_type_omtp", CVVM = "vvm_type_cvvm";

 public final String type, destination, clientPrefix;
 /** The data-SMS port requests go to; 0 sends them as text. */
 public final int port;
 public final boolean prefetch, tls, cellularRequired;
 /** IMAP capabilities (upper case) the carrier says not to use even when its server advertises them. */
 public final Set<String> disabledCapabilities;

 CarrierVvm(String type, String destination, int port, String clientPrefix, boolean prefetch, boolean tls, boolean cellularRequired, Set<String> disabledCapabilities) {
  this.type = type; this.destination = destination; this.port = port; this.clientPrefix = clientPrefix;
  this.prefetch = prefetch; this.tls = tls; this.cellularRequired = cellularRequired; this.disabledCapabilities = Collections.unmodifiableSet(disabledCapabilities);
 }
 public boolean cvvm() { return CVVM.equals(type); }

 public static CarrierVvm from(PersistableBundle config) {
  if (config == null) return null;
  String type = config.getString(CarrierConfigManager.KEY_VVM_TYPE_STRING);
  if (!OMTP.equals(type) && !CVVM.equals(type)) return null;
  if (config.getBoolean(CarrierConfigManager.KEY_VVM_LEGACY_MODE_ENABLED_BOOL, false)) return null;
  String destination = config.getString(CarrierConfigManager.KEY_VVM_DESTINATION_NUMBER_STRING);
  if (destination == null || !destination.matches("[0-9+*#]{1,32}")) return null;
  int port = config.getInt(CarrierConfigManager.KEY_VVM_PORT_NUMBER_INT, 0);
  if (port < 0 || port > 65535) return null;
  String prefix = config.getString(CarrierConfigManager.KEY_VVM_CLIENT_PREFIX_STRING);
  if (prefix == null || prefix.isEmpty()) prefix = OmtpSms.DEFAULT_PREFIX;
  if (!prefix.matches("[\\x21-\\x7e]{1,32}")) return null;
  Set<String> disabled = new HashSet<>();
  String[] names = config.getStringArray(CarrierConfigManager.KEY_VVM_DISABLED_CAPABILITIES_STRING_ARRAY);
  if (names != null) for (String name : names) if (name != null && disabled.size() < 64) disabled.add(name.toUpperCase(Locale.ROOT));
  return new CarrierVvm(type, destination, port, prefix, config.getBoolean(CarrierConfigManager.KEY_VVM_PREFETCH_BOOL, true),
    config.getBoolean(CarrierConfigManager.KEY_VVM_SSL_ENABLED_BOOL, false), config.getBoolean(CarrierConfigManager.KEY_VVM_CELLULAR_DATA_REQUIRED_BOOL, false), disabled);
 }
}
