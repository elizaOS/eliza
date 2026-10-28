package android.os;
import java.util.ArrayList;
import java.util.List;
/** Host stub: a virtual-time queue the tests advance explicitly. */
public class Handler {
 private static final class Entry{final Runnable r;final long at;Entry(Runnable r,long at){this.r=r;this.at=at;}}
 private final List<Entry> queue=new ArrayList<>();
 public long now;
 public final boolean post(Runnable r){queue.add(new Entry(r,now));return true;}
 public final boolean postDelayed(Runnable r,long delay){queue.add(new Entry(r,now+delay));return true;}
 public final void removeCallbacks(Runnable r){queue.removeIf(e->e.r==r);}
 /** Runs every entry due at or before {@code until}, in time order, advancing {@link #now}. */
 public void advanceTo(long until){
  while(true){
   Entry next=null;for(Entry e:queue)if(e.at<=until&&(next==null||e.at<next.at))next=e;
   if(next==null)break;
   queue.remove(next);now=Math.max(now,next.at);next.r.run();
  }
  now=until;
 }
}
