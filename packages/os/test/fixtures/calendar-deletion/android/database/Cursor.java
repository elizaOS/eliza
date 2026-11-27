// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.database;

public interface Cursor extends java.io.Closeable {
  int FIELD_TYPE_NULL = 0;
  int FIELD_TYPE_INTEGER = 1;
  int FIELD_TYPE_STRING = 3;
  boolean moveToFirst();
  boolean moveToNext();
  int getCount();
  boolean isNull(int column);
  int getType(int column);
  long getLong(int column);
  int getInt(int column);
  String getString(int column);
  @Override void close();
}
