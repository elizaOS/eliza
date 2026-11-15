import ai.eliza.plugins.browsersurface.ChromiumBindingDemand;
import ai.eliza.plugins.browsersurface.ChromiumBindingDemand.BindResult;
import ai.eliza.plugins.browsersurface.ChromiumBindingDemand.Hold;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;

/** Executes Quint operations against the production class and returns observed state. */
public final class ChromiumBindingDemandReplay {
  private static final class ManualHost implements ChromiumBindingDemand.Host {
    BindResult answer = BindResult.ACCEPTED;
    String verdict = "none";
    final List<Runnable> tasks = new ArrayList<>();
    @Override public BindResult bind() { verdict = answer.name(); return answer; }
    @Override public void unbind() {}
    @Override public void schedule(Runnable task, long delay) { tasks.add(task); }
    @Override public void cancel(Runnable task) { tasks.removeIf(value -> value == task); }
    void fire(Runnable task) {
      if (!tasks.remove(task)) throw new AssertionError("Timer was not scheduled");
      task.run();
    }
  }
  private static Object field(Object value, String name) throws Exception {
    Field field = value.getClass().getDeclaredField(name);
    field.setAccessible(true);
    return field.get(value);
  }
  private final ManualHost host = new ManualHost();
  private final ChromiumBindingDemand demand = new ChromiumBindingDemand(5000, host);
  private final Hold[] holds = new Hold[2];
  private final String[] effects = {"record", "record"};
  private int registered;
  private int fired;
  private boolean unsafeCallback;

  private void callback(int id) {
    unsafeCallback |= demand.isClosed() || !demand.isReady() || !holds[id].isOpen()
        || (fired & (1 << id)) != 0;
    fired |= 1 << id;
    switch (effects[id]) {
      case "self": holds[id].close(); break;
      case "other": if (holds[1 - id] != null) holds[1 - id].close(); break;
      case "close": demand.close(); break;
      case "disconnect": demand.disconnected(); break;
      case "record": break;
      default: throw new AssertionError("Unknown callback effect");
    }
  }
  private void apply(String[] command) throws Exception {
    int id = Integer.parseInt(command[1]);
    host.answer = BindResult.valueOf(command[2]);
    switch (command[0]) {
      case "init": break;
      case "acquire": holds[id] = demand.acquire(); break;
      case "pin": demand.pin(); break;
      case "unpin": demand.unpin(); break;
      case "release": holds[id].close(); break;
      case "register":
        effects[id] = command[3];
        registered |= 1 << id;
        holds[id].whenReady(() -> callback(id));
        break;
      case "connect": demand.connected(); break;
      case "disconnect": demand.disconnected(); break;
      case "lost": host.verdict = "lost"; demand.bindingLost(); break;
      case "retry": host.fire((Runnable) field(demand, "reconnect")); break;
      case "idle": host.fire((Runnable) field(demand, "idleRelease")); break;
      case "close": demand.close(); break;
      default: throw new AssertionError("Unknown operation " + command[0]);
    }
  }
  private String snapshot() throws Exception {
    int acquired = 0;
    int open = 0;
    for (int id = 0; id < holds.length; id++) {
      if (holds[id] != null) acquired |= 1 << id;
      if (holds[id] != null && holds[id].isOpen()) open |= 1 << id;
    }
    List<String> queued = new ArrayList<>();
    for (Object waiter : (List<?>) field(demand, "waiting")) {
      Object owner = field(waiter, "hold");
      queued.add(owner == holds[0] ? "0" : owner == holds[1] ? "1" : "unknown");
    }
    long millis = (Long) field(demand, "retryMillis");
    int backoff = List.of(1000L, 2000L, 4000L, 8000L, 16000L, 30000L).indexOf(millis);
    return String.join("\t", String.valueOf(field(demand, "pinned")),
        String.valueOf(field(demand, "leases")), String.valueOf(demand.isBound()),
        String.valueOf(demand.isReady()), String.valueOf(demand.isClosed()),
        String.valueOf(acquired), String.valueOf(open), String.valueOf(registered),
        String.valueOf(fired), String.join(",", queued), effects[0], effects[1],
        String.valueOf(host.tasks.contains(field(demand, "reconnect"))),
        String.valueOf(host.tasks.contains(field(demand, "idleRelease"))),
        String.valueOf(backoff), host.verdict, String.valueOf(unsafeCallback));
  }
  public static void main(String[] args) throws Exception {
    ChromiumBindingDemandReplay replay = null;
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in));
    for (String line; (line = input.readLine()) != null;) {
      String[] command = line.split("\t", -1);
      if (command[0].equals("init")) replay = new ChromiumBindingDemandReplay();
      if (replay == null) throw new AssertionError("Missing init");
      replay.apply(command);
      System.out.println(replay.snapshot());
    }
  }
}
