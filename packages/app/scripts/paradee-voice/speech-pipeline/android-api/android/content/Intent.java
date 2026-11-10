package android.content;

import java.util.HashMap;
import java.util.Map;

/** Test double: extras are kept for the scripted recognition service. */
public class Intent {
    private final Map<String, Object> extras = new HashMap<>();

    public Intent(String action) {}

    public Intent putExtra(String name, String value) {
        extras.put(name, value);
        return this;
    }

    public Intent putExtra(String name, boolean value) {
        extras.put(name, value);
        return this;
    }

    public Intent putExtra(String name, int value) {
        extras.put(name, value);
        return this;
    }

    public Intent putExtra(String name, Object value) {
        extras.put(name, value);
        return this;
    }

    public Object extra(String name) {
        return extras.get(name);
    }
}
