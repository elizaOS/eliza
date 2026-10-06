package ai.eliza.plugins.reminders;
import android.content.Context;
/** Host supplies existing encrypted, durable storage. Never change its keys during extraction. */
public interface SecureStringStore {
 /** Stable identity of the backing encrypted storage, not the Java wrapper instance. */
 String identity();
 String read(String key) throws Exception;
 /** Return only after durable commit; throw on uncertainty. */
 void write(String key,String value) throws Exception;
 interface Factory { SecureStringStore create(Context applicationContext); }
}
