package ai.eliza.sense;

import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Quick Settings "Listening" tile. Pausing works from the lock screen; resuming asks the user to
 * unlock first; when listening is off or needs attention the tile opens the listener settings
 * (after unlock), where consent is given or withdrawn. It never turns listening on by itself.
 */
public class ListenerTileService extends TileService {
 @Override public void onStartListening(){render();}

 @Override public void onClick(){
  ListenerPolicy.State state=Listener.state(this);
  ListenerStore store=new ListenerStore(this);
  if(ListenerPolicy.holdsMicrophone(state)||state==ListenerPolicy.State.PAUSED_CALL||ListenerPolicy.indicatorPaused(state)){
   store.pause(ListenerPolicy.PAUSE_UNTIL_RESUMED);
   Listener.refresh(this);
   render();
  }else if(state==ListenerPolicy.State.PAUSED_USER||state==ListenerPolicy.State.STOPPED_INDICATOR_LOST){
   Runnable resume=()->{store.resume();Listener.refresh(this);render();};
   if(isLocked())unlockAndRun(resume);else resume.run();
  }else{
   Intent settings=new Intent().setComponent(SenseConfig.component(this,"ConsentActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
   PendingIntent open=PendingIntent.getActivity(this,20,settings,PendingIntent.FLAG_IMMUTABLE);
   Runnable launch=()->startActivityAndCollapse(open);
   if(isLocked())unlockAndRun(launch);else launch.run();
  }
 }

 private void render(){
  Tile tile=getQsTile();
  if(tile==null)return;
  ListenerPolicy.State state=Listener.state(this);
  tile.setLabel("Listening");
  tile.setSubtitle(ListenerPolicy.processesAudio(state)?"On":ListenerPolicy.foreground(state)?"Paused":"Off");
  tile.setStateDescription(ListenerPolicy.label(state));
  tile.setIcon(Icon.createWithResource(this,R.drawable.ic_listening));
  tile.setState(ListenerPolicy.processesAudio(state)?Tile.STATE_ACTIVE:Tile.STATE_INACTIVE);
  tile.updateTile();
 }
}
