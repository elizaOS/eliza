package android.database;
public interface Cursor extends AutoCloseable {int FIELD_TYPE_INTEGER=1;boolean moveToFirst();boolean isNull(int column);int getType(int column);boolean moveToNext();long getLong(int column);String getString(int column);int getInt(int column);void close();}
