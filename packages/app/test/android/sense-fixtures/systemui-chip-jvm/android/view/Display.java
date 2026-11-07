package android.view;
public final class Display {
 public static final int DEFAULT_DISPLAY=0;
 public static final int STATE_UNKNOWN=0,STATE_OFF=1,STATE_ON=2,STATE_DOZE=3,STATE_DOZE_SUSPEND=4,STATE_VR=5,STATE_ON_SUSPEND=6;
 /** Host stub: tests set the reported state. */
 public int stubState=STATE_UNKNOWN;
 public int getState(){return stubState;}
}
