package android.content;
public final class ComponentName {
 private final String pkg,cls;
 public ComponentName(String pkg,String cls){this.pkg=pkg;this.cls=cls;}
 @Override public boolean equals(Object o){return o instanceof ComponentName&&((ComponentName)o).pkg.equals(pkg)&&((ComponentName)o).cls.equals(cls);}
 @Override public int hashCode(){return pkg.hashCode()*31+cls.hashCode();}
}
