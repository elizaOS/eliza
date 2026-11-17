package android.database;
public interface Cursor extends AutoCloseable {int FIELD_TYPE_INTEGER=1;boolean moveToFirst();boolean moveToNext();boolean isNull(int column);int getType(int column);long getLong(int column);String getString(int column);int getInt(int column);int getCount();void close();}
