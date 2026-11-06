package android.content;

/** Test double: extras are accepted and ignored. */
public class Intent {
    public Intent(String action) {}

    public Intent putExtra(String name, String value) {
        return this;
    }

    public Intent putExtra(String name, boolean value) {
        return this;
    }

    public Intent putExtra(String name, int value) {
        return this;
    }

    public Intent putExtra(String name, Object value) {
        return this;
    }
}
