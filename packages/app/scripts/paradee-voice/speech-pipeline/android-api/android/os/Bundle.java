package android.os;

import java.util.ArrayList;

public class Bundle {
    public ArrayList<String> results;

    public ArrayList<String> getStringArrayList(String key) {
        return results;
    }
}
