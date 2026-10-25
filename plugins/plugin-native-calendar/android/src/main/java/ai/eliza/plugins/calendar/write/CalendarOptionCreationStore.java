package ai.eliza.plugins.calendar.write;

import android.content.ContentValues;
import android.content.Context;
import android.provider.CalendarContract;
import ai.eliza.plugins.calendar.CalendarConfiguration;
import ai.eliza.plugins.calendar.CalendarCreationStore;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

/** Options preserve their installed namespace and binding format while reusing the shared journal. */
public final class CalendarOptionCreationStore {
 static final String[] FIELDS = {CalendarContract.Events.CALENDAR_ID, CalendarContract.Events.TITLE, CalendarContract.Events.DESCRIPTION, CalendarContract.Events.EVENT_LOCATION,
  CalendarContract.Events.DTSTART, CalendarContract.Events.DTEND, CalendarContract.Events.DURATION, CalendarContract.Events.EVENT_TIMEZONE, CalendarContract.Events.ALL_DAY, CalendarContract.Events.RRULE};
 private final CalendarCreationStore journal;
 public CalendarOptionCreationStore(CalendarConfiguration configuration){
  journal=new CalendarCreationStore(configuration.journalName+"-options",configuration.creationUriPrefix+"options/",FIELDS);
 }
 public boolean hasPending(Context context)throws Exception{return journal.hasPending(context);}
 public JSObject create(Context context,String id,ContentValues values,boolean separate)throws Exception{return journal.create(context,id,values,separate);}
 public JSArray pendingCreations(Context context)throws Exception{return journal.pendingCreationRows(context);}
 public boolean owns(Context context,String id)throws Exception{return journal.owns(context,id);}
 public void acknowledge(Context context,String id)throws Exception{journal.acknowledge(context,id);}
}
