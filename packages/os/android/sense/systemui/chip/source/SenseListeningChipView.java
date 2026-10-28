package com.android.systemui.privacy;

import android.content.Context;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.Gravity;
import android.view.View;
import android.view.ViewParent;
import android.view.ViewGroup;
import android.widget.TextView;
import com.android.systemui.res.R;

/** Independent fixed-text surface. Its measured visibility feeds the listener's health lease. */
public final class SenseListeningChipView extends TextView {
 private boolean aggregated; // main thread only
 /** Created in code by the keyguard indication-area section (lock screen and AOD); inflated in status_bar.xml otherwise. */
 private final boolean keyguard;
 private boolean shade;
 static SenseListeningChipView shade(Context context){
  SenseListeningChipView view=new SenseListeningChipView(context,null,false);view.shade=true;
  int target=(int)Math.ceil(48*context.getResources().getDisplayMetrics().density);
  view.setMinWidth(target);view.setMinHeight(target);view.setFilterTouchesWhenObscured(true);return view;
 }
 boolean shadeSurface(){return shade;}
 void renderShade(boolean active){if((getVisibility()==VISIBLE)!=active)render(active);}
 boolean topmostIn(ViewGroup root){
  if(getParent()!=root||root.indexOfChild(this)!=root.getChildCount()-1||!Float.isFinite(getZ()))return false;
  for(int i=0;i<root.getChildCount();i++){View other=root.getChildAt(i);if(other!=this&&(!Float.isFinite(other.getZ())||other.getZ()>getZ()))return false;}
  return true;
 }
 public SenseListeningChipView(Context context){this(context,null,true);}
 public SenseListeningChipView(Context context,AttributeSet attrs){this(context,attrs,false);}
 private SenseListeningChipView(Context context,AttributeSet attrs,boolean keyguard){
  super(context,attrs);this.keyguard=keyguard;setGravity(Gravity.CENTER);setTextSize(12);setTextColor(0xffffffff);
  setBackgroundColor(0xff174e35);setPadding(8,2,8,2);setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
  setOnClickListener(view->{if(!SenseListeningController.pause())announceForAccessibility(getContext().getString(R.string.sense_listening_pause_unavailable));});
  render(false);
 }
 @Override protected void onAttachedToWindow(){super.onAttachedToWindow();SenseListeningController.attach(this);}
 @Override protected void onDetachedFromWindow(){SenseListeningController.detach(this);super.onDetachedFromWindow();}
 @Override public void onVisibilityAggregated(boolean visible){super.onVisibilityAggregated(visible);aggregated=visible;SenseListeningController.surfaceChanged();}
 @Override protected void onWindowVisibilityChanged(int visibility){super.onWindowVisibilityChanged(visibility);SenseListeningController.surfaceChanged();}
 void render(boolean active){setText(R.string.sense_listening_pause);setContentDescription(getContext().getString(R.string.sense_listening_pause));setVisibility(active?VISIBLE:GONE);setEnabled(active);SenseListeningController.surfaceChanged();}

 /** Lock-screen/AOD surface rather than the status bar. */
 boolean keyguardSurface(){return keyguard;}

 /** The rendered chip itself is effectively on screen. */
 boolean chipVisible(){return getVisibility()==VISIBLE&&measured(this,aggregated);}

 /** The surface that shows the chip (status bar or keyguard indication area) is effectively on screen. */
 boolean hostVisible(){ViewParent parent=getParent();return parent instanceof View&&measured((View)parent,((View)parent).isShown());}

 private static boolean measured(View view,boolean aggregated){
  Rect rect=new Rect();
  boolean onScreen=view.getGlobalVisibleRect(rect);
  float alpha=view.getAlpha();
  for(ViewParent node=view.getParent();node instanceof View;node=node.getParent())alpha*=((View)node).getAlpha();
  return SenseListeningPolicy.effectivelyVisible(view.isAttachedToWindow(),view.getWindowVisibility()==VISIBLE,view.isShown(),aggregated,
   alpha,onScreen?(long)rect.width()*rect.height():0,(long)view.getWidth()*view.getHeight());
 }
}
