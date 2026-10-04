package ai.eliza.plugins.securestore.nativeonly;

import android.os.SystemClock;
import java.util.*;

/** Ephemeral, one-shot capabilities. No credentials, Intent-supplied field ids, or disk state. */
public final class PasswordAutofillSessions {
  public static final class Session {
    public final PasswordAutofillRequest request;
    final long created=SystemClock.elapsedRealtime();
    public volatile boolean cancelled;
    Session(PasswordAutofillRequest request){this.request=request;}
    public boolean valid(){return !cancelled && SystemClock.elapsedRealtime()-created<120000;}
  }
  private static final Map<String,Session> pending=new HashMap<>();
  private static Session current;
  private static String currentToken;
  public static synchronized void invalidate(){if(current!=null)current.cancelled=true;pending.clear();}
  public static synchronized String create(PasswordAutofillRequest request){
    invalidate();
    current=new Session(request);String token=UUID.randomUUID().toString();pending.put(token,current);currentToken=token;return token;
  }
  public static synchronized Session take(String token){Session session=pending.remove(token);return session!=null && session.valid()?session:null;}
  public static synchronized void cancel(String token){Session session=pending.remove(token);if(session!=null)session.cancelled=true; if(token.equals(currentToken) && current!=null)current.cancelled=true;}
}
