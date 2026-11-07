package android.view;
import android.content.Context;
import android.graphics.Rect;
/** Host stub. The public stub* fields let JVM tests set what a real view would measure. */
public class View {
 public static final int VISIBLE=0,INVISIBLE=4,GONE=8,ACCESSIBILITY_LIVE_REGION_POLITE=1;
 public interface OnAttachStateChangeListener{void onViewAttachedToWindow(View view);void onViewDetachedFromWindow(View view);}
 public void addOnAttachStateChangeListener(OnAttachStateChangeListener listener){}
 public interface OnClickListener{void onClick(View view);}
 private final Context context;
 private int visibility=VISIBLE;
 public ViewParent stubParent;
 public boolean stubShown,stubAttached;
 public int stubWindowVisibility=GONE,stubWidth,stubHeight,stubVisibleWidth,stubVisibleHeight;
 public float stubAlpha=1f;
 public boolean stubFocus=true;private float z;private Object params;
 public boolean hasWindowFocus(){return stubFocus;}
 public float getZ(){return z;}public void setZ(float value){z=value;}
 public void bringToFront(){if(stubParent instanceof ViewGroup)((ViewGroup)stubParent).front(this);}
 public Object getLayoutParams(){return params;}public void setLayoutParams(Object value){params=value;}
 public boolean stubLayoutRequested;public boolean isLayoutRequested(){return stubLayoutRequested;}
 public WindowInsets stubInsets=new WindowInsets();public WindowInsets getRootWindowInsets(){return stubInsets;}
 public ViewTreeObserver getViewTreeObserver(){return new ViewTreeObserver();}
 public void setMinWidth(int width){}public void setMinHeight(int height){}public void setFilterTouchesWhenObscured(boolean filter){}

 public View(Context context){this.context=context;}
 public View(Context context,android.util.AttributeSet attrs){this.context=context;}
 public final Context getContext(){return context;}
 public final ViewParent getParent(){return stubParent;}
 public void setVisibility(int visibility){this.visibility=visibility;}
 public int getVisibility(){return visibility;}
 public boolean isShown(){return stubShown&&visibility==VISIBLE;}
 public boolean isAttachedToWindow(){return stubAttached;}
 public int getWindowVisibility(){return stubWindowVisibility;}
 public float getAlpha(){return stubAlpha;}
 public final int getWidth(){return stubWidth;}
 public final int getHeight(){return stubHeight;}
 public final boolean getGlobalVisibleRect(Rect r){r.left=0;r.top=0;r.right=stubVisibleWidth;r.bottom=stubVisibleHeight;return stubVisibleWidth>0&&stubVisibleHeight>0;}
 public void setEnabled(boolean enabled){}
 public void setOnClickListener(OnClickListener l){}
 public void setPadding(int l,int t,int r,int b){}
 public void setBackgroundColor(int color){}
 public void setAccessibilityLiveRegion(int mode){}
 public void announceForAccessibility(CharSequence text){}
 public void setContentDescription(CharSequence text){}
 protected void onAttachedToWindow(){}
 protected void onDetachedFromWindow(){}
 protected void onWindowVisibilityChanged(int visibility){}
 public void onVisibilityAggregated(boolean isVisible){}
}
