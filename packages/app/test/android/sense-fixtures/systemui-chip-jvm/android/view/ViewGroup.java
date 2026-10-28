package android.view;
import android.content.Context;
public class ViewGroup extends View implements ViewParent {
 private final java.util.List<View> children=new java.util.ArrayList<>();
 public ViewGroup(Context context){super(context);}
 public int getChildCount(){return children.size();}public View getChildAt(int i){return children.get(i);}
 public int indexOfChild(View v){return children.indexOf(v);}
 public void addView(View v,Object params){children.add(v);v.stubParent=this;v.setLayoutParams(params);}
 public void removeAllViews(){for(View child:children)child.stubParent=null;children.clear();}
 public void front(View v){children.remove(v);children.add(v);}
}
