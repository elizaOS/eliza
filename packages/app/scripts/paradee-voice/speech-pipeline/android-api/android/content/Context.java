package android.content;

/** Test double: the application context is itself. */
public class Context {
    public Context getApplicationContext() {
        return this;
    }
}
