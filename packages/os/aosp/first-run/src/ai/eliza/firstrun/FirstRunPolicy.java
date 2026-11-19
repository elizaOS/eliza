// spec/os/image/firstRun.md, "Story: Have my device's default apps set on first boot without overriding my choices"
package ai.eliza.firstrun;

import java.util.Collections;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class FirstRunPolicy {
    private FirstRunPolicy() {}

    public enum Role {
        HOME("home", "android.app.role.HOME"),
        ASSISTANT("assistant", "android.app.role.ASSISTANT"),
        DIALER("dialer", "android.app.role.DIALER"),
        SMS("sms", "android.app.role.SMS");

        public final String item;
        public final String android;

        Role(String item, String android) {
            this.item = item;
            this.android = android;
        }

        static Role named(String item) {
            for (Role role : values()) if (role.item.equals(item)) return role;
            return null;
        }
    }

    public enum Phase {
        PENDING, SKIPPED, ASSIGNING, RETRY, DONE, RETIRED;

        public boolean finished() {
            return this == DONE || this == RETIRED;
        }
    }

    public record Descriptor(boolean active, Map<Role, String> packages) {
        public Set<Role> roles() {
            return packages.keySet();
        }
    }

    public record Device(boolean systemUser, boolean mainUser, boolean managed, boolean profile, boolean telephony) {
        public boolean eligible() {
            return systemUser && mainUser && !managed && !profile;
        }
    }

    public record Reading(Set<Role> unavailable, Set<Role> product, Set<Role> owner) {}

    public record State(Phase phase, Set<Role> required, Set<Role> confirmed, Set<Role> assigning) {}

    public enum Sort { UNAVAILABLE, PRODUCT, OWNER, OPEN }

    public interface Port {
        Device device();
        boolean available(Role role);
        List<String> holders(Role role);
        boolean enabledInImage(String packageName);
        boolean shippedByImage(String packageName);
        State load();
        boolean save(State state);
        boolean assign(Role role, String packageName);
    }

    public enum Attempt { INACTIVE, FINISHED, UNREADABLE_STATE, UNSAVED, ATTEMPTED }

    public record Result(Attempt attempt, State state) {}

    public static final State INITIAL = new State(Phase.PENDING, Set.of(), Set.of(), Set.of());
    private static final Reading NOTHING_READ = new Reading(Set.of(), Set.of(), Set.of());
    private static final Pattern PACKAGE = Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+");

    public static Descriptor descriptor(boolean enabled, List<String> items) {
        Map<Role, String> packages = new EnumMap<>(Role.class);
        boolean valid = true;
        for (String item : items) {
            int split = item.indexOf('=');
            Role role = split < 0 ? null : Role.named(item.substring(0, split).trim());
            String packageName = split < 0 ? "" : item.substring(split + 1).trim();
            if (role == null || !PACKAGE.matcher(packageName).matches() || packages.putIfAbsent(role, packageName) != null) valid = false;
        }
        boolean active = enabled && valid && packages.containsKey(Role.HOME);
        return new Descriptor(active, active ? Collections.unmodifiableMap(packages) : Map.of());
    }

    public static Set<Role> requiredRoles(Set<Role> declared, boolean telephony) {
        Set<Role> required = EnumSet.of(Role.HOME);
        for (Role role : declared)
            if (role == Role.ASSISTANT || (telephony && (role == Role.DIALER || role == Role.SMS))) required.add(role);
        return Collections.unmodifiableSet(required);
    }

    public static boolean wellRead(Set<Role> required, Reading reading) {
        Set<Role> all = union(union(reading.unavailable(), reading.product()), reading.owner());
        return required.containsAll(all) && all.size() == reading.unavailable().size() + reading.product().size() + reading.owner().size();
    }

    static boolean ownerChose(Set<Role> confirmed, Reading reading) {
        return !reading.owner().isEmpty() || !reading.product().containsAll(minus(confirmed, reading.unavailable()));
    }

    static State attempted(Set<Role> required, Set<Role> confirmed, Reading reading) {
        Set<Role> known = union(confirmed, reading.product());
        if (ownerChose(confirmed, reading)) return new State(Phase.RETIRED, required, known, Set.of());
        if (!reading.unavailable().isEmpty()) return new State(Phase.RETRY, required, known, Set.of());
        if (reading.product().containsAll(required)) return new State(Phase.DONE, required, known, Set.of());
        return new State(Phase.ASSIGNING, required, known, minus(required, reading.product()));
    }

    public static boolean canBegin(State state, Descriptor descriptor, Device device, Reading reading) {
        return descriptor.active() && !state.phase().finished()
                && (!device.eligible() || wellRead(requiredRoles(descriptor.roles(), device.telephony()), reading));
    }

    public static State begin(State state, Descriptor descriptor, Device device, Reading reading) {
        Set<Role> required = requiredRoles(descriptor.roles(), device.telephony());
        if (!device.eligible()) return new State(Phase.SKIPPED, state.required(), state.confirmed(), Set.of());
        return attempted(required, intersect(state.confirmed(), required), reading);
    }

    public static boolean canReadBack(State state, Reading reading) {
        return state.phase() == Phase.ASSIGNING && wellRead(state.required(), reading);
    }

    public static State readBack(State state, Reading reading) {
        State read = attempted(state.required(), state.confirmed(), reading);
        return read.phase() == Phase.ASSIGNING ? new State(Phase.RETRY, read.required(), read.confirmed(), Set.of()) : read;
    }

    public static Sort sort(boolean available, List<String> holders, boolean productEnabled, String product, Port port) {
        if (!available || holders == null || !productEnabled) return Sort.UNAVAILABLE;
        if (holders.equals(List.of(product))) return Sort.PRODUCT;
        for (String holder : holders) if (!port.shippedByImage(holder)) return Sort.OWNER;
        return Sort.OPEN;
    }

    static Reading read(Set<Role> required, Descriptor descriptor, Port port) {
        Set<Role> unavailable = EnumSet.noneOf(Role.class), product = EnumSet.noneOf(Role.class), owner = EnumSet.noneOf(Role.class);
        for (Role role : required) {
            String packageName = descriptor.packages().get(role);
            switch (sort(port.available(role), port.holders(role), port.enabledInImage(packageName), packageName, port)) {
                case UNAVAILABLE -> unavailable.add(role);
                case PRODUCT -> product.add(role);
                case OWNER -> owner.add(role);
                case OPEN -> {}
            }
        }
        return new Reading(unavailable, product, owner);
    }

    public static Result attempt(Descriptor descriptor, Port port) {
        State state = port.load();
        if (state == null) return new Result(Attempt.UNREADABLE_STATE, INITIAL);
        if (!descriptor.active()) return new Result(Attempt.INACTIVE, state);
        if (state.phase().finished()) return new Result(Attempt.FINISHED, state);
        Device device = port.device();
        Reading reading = device.eligible() ? read(requiredRoles(descriptor.roles(), device.telephony()), descriptor, port) : NOTHING_READ;
        State begun = begin(state, descriptor, device, reading);
        if (!port.save(begun)) return new Result(Attempt.UNSAVED, state);
        if (begun.phase() != Phase.ASSIGNING) return new Result(Attempt.ATTEMPTED, begun);
        for (Role role : begun.assigning()) port.assign(role, descriptor.packages().get(role));
        State after = readBack(begun, read(begun.required(), descriptor, port));
        return new Result(port.save(after) ? Attempt.ATTEMPTED : Attempt.UNSAVED, after);
    }

    public static String encode(State state) {
        return String.join(";", state.phase().name(), names(state.required()), names(state.confirmed()), names(state.assigning()));
    }

    public static State decode(String stored) {
        if (stored == null) return INITIAL;
        String[] parts = stored.split(";", -1);
        if (parts.length != 4) return null;
        try {
            State state = new State(Phase.valueOf(parts[0]), roles(parts[1]), roles(parts[2]), roles(parts[3]));
            return holds(state) ? state : null;
        } catch (IllegalArgumentException malformed) {
            return null;
        }
    }

    public static boolean holds(State s) {
        return s.required().containsAll(s.assigning()) && intersect(s.assigning(), s.confirmed()).isEmpty()
                && (s.phase() == Phase.ASSIGNING) == !s.assigning().isEmpty()
                && (!(s.phase() == Phase.ASSIGNING || s.phase() == Phase.DONE) || s.required().contains(Role.HOME))
                && (s.phase() != Phase.DONE || s.confirmed().containsAll(s.required()));
    }

    private static String names(Set<Role> roles) {
        StringBuilder out = new StringBuilder();
        for (Role role : roles) out.append(out.length() == 0 ? "" : ",").append(role.name());
        return out.toString();
    }

    private static Set<Role> roles(String names) {
        if (names.isEmpty()) return Set.of();
        Set<Role> roles = EnumSet.noneOf(Role.class);
        for (String name : names.split(",", -1)) if (!roles.add(Role.valueOf(name))) throw new IllegalArgumentException("role named twice: " + name);
        return Collections.unmodifiableSet(roles);
    }

    private static Set<Role> union(Set<Role> a, Set<Role> b) {
        Set<Role> out = EnumSet.noneOf(Role.class);
        out.addAll(a);
        out.addAll(b);
        return Collections.unmodifiableSet(out);
    }

    private static Set<Role> minus(Set<Role> a, Set<Role> b) {
        Set<Role> out = EnumSet.noneOf(Role.class);
        out.addAll(a);
        out.removeAll(b);
        return Collections.unmodifiableSet(out);
    }

    private static Set<Role> intersect(Set<Role> a, Set<Role> b) {
        Set<Role> out = EnumSet.noneOf(Role.class);
        out.addAll(a);
        out.retainAll(b);
        return Collections.unmodifiableSet(out);
    }
}
