// SPDX-License-Identifier: MIT
// spec/os/update/updater.md, "Story: Install a verified update once"
package ai.eliza.systemupdater;

import ai.eliza.systemupdater.UpdateAdmission.Conditions;
import ai.eliza.systemupdater.UpdateAdmission.Engine;
import ai.eliza.systemupdater.UpdateAdmission.ManifestFacts;
import ai.eliza.systemupdater.UpdateAdmission.Offer;
import ai.eliza.systemupdater.UpdateAdmission.Release;
import java.util.function.Supplier;

/** Durable OS-update transitions. Persist a returned state before invoking Android. */
public final class UpdateJournal {
    public enum Phase {
        IDLE, DOWNLOADING, VERIFIED, APPLY_INTENT, APPLYING,
        REBOOT_READY, REBOOT_INTENT, COMPLETE, SOURCE_RETAINED, FAILED, UNKNOWN
    }

    public enum RestartHold { NOT_HELD, CONDITIONS, OFFER_UNAVAILABLE, NO_OFFER, OFFER_CHANGED, ENGINE }

    public final Phase phase;
    public final String sourceBuild;
    public final String targetBuild;
    public final String packageSha256;
    public final String intentBoot;
    public final int applyCalls;
    public final RestartHold restartHold;

    // spec/os/update/updater.md, "A journal that is not idle binds two different builds and a digest, and an apply or restart phase binds a boot"
    public UpdateJournal(Phase phase, String sourceBuild, String targetBuild, String packageSha256,
            String intentBoot, int applyCalls, RestartHold restartHold) {
        if (phase == null || sourceBuild == null || targetBuild == null
                || packageSha256 == null || intentBoot == null || restartHold == null) {
            throw new IllegalArgumentException("Incomplete update journal");
        }
        if (phase == Phase.IDLE ? !(sourceBuild.isEmpty() && targetBuild.isEmpty() && packageSha256.isEmpty()
                && intentBoot.isEmpty() && applyCalls == 0)
                : sourceBuild.isEmpty() || targetBuild.isEmpty() || sourceBuild.equals(targetBuild)
                        || !packageSha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Unbound update journal");
        }
        if (bootBound(phase) && intentBoot.isEmpty()) {
            throw new IllegalArgumentException("Update intent has no boot identity");
        }
        // spec/os/update/updater.md, "An apply intent is persisted before the one apply call, and only for a verified candidate the offer still matches"
        boolean once = switch (phase) {
            case DOWNLOADING, VERIFIED -> applyCalls == 0 && intentBoot.isEmpty();
            case APPLY_INTENT -> applyCalls == 0;
            case APPLYING, REBOOT_READY, REBOOT_INTENT -> applyCalls == 1;
            case FAILED -> (applyCalls == 1) == !intentBoot.isEmpty();
            case IDLE, COMPLETE, SOURCE_RETAINED, UNKNOWN -> applyCalls == 0 || applyCalls == 1;
        };
        if (!once) throw new IllegalArgumentException("Update journal apply count is inconsistent");
        if (restartHold != RestartHold.NOT_HELD && phase != Phase.REBOOT_READY) {
            throw new IllegalArgumentException("Only an applied candidate can hold its restart");
        }
        this.phase = phase;
        this.sourceBuild = sourceBuild;
        this.targetBuild = targetBuild;
        this.packageSha256 = packageSha256;
        this.intentBoot = intentBoot;
        this.applyCalls = applyCalls;
        this.restartHold = restartHold;
    }

    public static UpdateJournal idle() {
        return new UpdateJournal(Phase.IDLE, "", "", "", "", 0, RestartHold.NOT_HELD);
    }

    private static boolean bootBound(Phase phase) {
        return phase == Phase.APPLY_INTENT || phase == Phase.APPLYING
                || phase == Phase.REBOOT_READY || phase == Phase.REBOOT_INTENT;
    }

    private UpdateJournal move(Phase next) {
        return new UpdateJournal(next, sourceBuild, targetBuild, packageSha256, intentBoot, applyCalls, RestartHold.NOT_HELD);
    }

    boolean same(UpdateJournal other) {
        return phase == other.phase && sourceBuild.equals(other.sourceBuild) && targetBuild.equals(other.targetBuild)
                && packageSha256.equals(other.packageSha256) && intentBoot.equals(other.intentBoot)
                && applyCalls == other.applyCalls && restartHold == other.restartHold;
    }

    // spec/os/update/updater.md, "A download starts only from a settled journal and never replays the previous target"
    public UpdateJournal download(Release installed, Release candidate, String digest,
            ManifestFacts manifest, Conditions conditions) {
        if (phase != Phase.IDLE && phase != Phase.COMPLETE && phase != Phase.SOURCE_RETAINED) {
            throw new IllegalStateException("Resolve the earlier update first");
        }
        if (candidate.fingerprint().equals(targetBuild)) {
            throw new IllegalStateException("Do not replay the previous candidate");
        }
        if (installed.fingerprint().isEmpty() || digest.isEmpty() || !UpdateAdmission.offered(installed, candidate)
                || !manifest.admitted() || !conditions.downloadAllowed()) {
            throw new IllegalStateException("Candidate is not admitted for download");
        }
        return new UpdateJournal(Phase.DOWNLOADING, installed.fingerprint(), candidate.fingerprint(), digest,
                "", 0, RestartHold.NOT_HELD);
    }

    // spec/os/update/updater.md, "A candidate is verified only for the installed build, candidate and digest its download recorded"
    public UpdateJournal verified(Release installed, Release candidate, String digest) {
        require(Phase.DOWNLOADING);
        if (!sourceBuild.equals(installed.fingerprint()) || !targetBuild.equals(candidate.fingerprint())
                || !packageSha256.equals(digest)) {
            throw new IllegalStateException("Verified package differs from discovery");
        }
        if (!UpdateAdmission.candidateAdmitted(installed, candidate)) {
            throw new IllegalStateException("Candidate lowers a patch level or is not newer");
        }
        return move(Phase.VERIFIED);
    }

    public UpdateJournal failedBeforeApply() {
        if (!isUnapplied()) throw new IllegalStateException("Cannot classify an apply as unstarted");
        return move(Phase.FAILED);
    }

    // spec/os/update/updater.md, "An apply intent is persisted before the one apply call, and only for a verified candidate the offer still matches"
    public UpdateJournal applyIntent(String boot, Engine engine, Conditions conditions, Offer offer) {
        require(Phase.VERIFIED);
        if (boot.isEmpty() || engine != Engine.IDLE || !conditions.installAllowed()
                || !offer.names(targetBuild, packageSha256)) {
            throw new IllegalStateException("Update engine, boot, phone or offer does not admit an apply");
        }
        return new UpdateJournal(Phase.APPLY_INTENT, sourceBuild, targetBuild, packageSha256, boot, 0, RestartHold.NOT_HELD);
    }

    boolean applyIntentStale(String boot, Conditions conditions) {
        return phase == Phase.APPLY_INTENT && (!boot.equals(intentBoot) || !conditions.installAllowed());
    }

    public UpdateJournal withdrawApplyIntent(String boot, Conditions conditions) {
        if (!applyIntentStale(boot, conditions)) throw new IllegalStateException("The apply intent still holds");
        return new UpdateJournal(Phase.VERIFIED, sourceBuild, targetBuild, packageSha256, "", 0, RestartHold.NOT_HELD);
    }

    public UpdateJournal applying(String boot) {
        require(Phase.APPLY_INTENT);
        if (!intentBoot.equals(boot) || applyCalls != 0) throw new IllegalStateException("Update belongs to another boot");
        return new UpdateJournal(Phase.APPLYING, sourceBuild, targetBuild, packageSha256, intentBoot, 1, RestartHold.NOT_HELD);
    }

    // spec/os/update/updater.md, "Only the attempt's own result ends an apply, and a stopped job never cancels it"
    public UpdateJournal completedApply(String boot, int errorCode) {
        require(Phase.APPLYING);
        if (!intentBoot.equals(boot)) return move(Phase.UNKNOWN);
        return move(errorCode == 0 ? Phase.REBOOT_READY : Phase.FAILED);
    }

    // spec/os/update/updater.md, "A restart is requested only while the phone, the offer and the engine all allow it"
    RestartHold restartBlocker(Conditions conditions, Supplier<Offer> offer, Supplier<Engine> engine) {
        if (!conditions.installAllowed()) return RestartHold.CONDITIONS;
        Offer current = offer.get();
        if (current.kind() == Offer.Kind.UNAVAILABLE) return RestartHold.OFFER_UNAVAILABLE;
        if (current.kind() == Offer.Kind.NONE) return RestartHold.NO_OFFER;
        if (!current.names(targetBuild, packageSha256)) return RestartHold.OFFER_CHANGED;
        if (engine.get() != Engine.NEEDS_REBOOT) return RestartHold.ENGINE;
        return RestartHold.NOT_HELD;
    }

    public UpdateJournal holdRestart(Conditions conditions, Supplier<Offer> offer, Supplier<Engine> engine) {
        require(Phase.REBOOT_READY);
        RestartHold hold = restartBlocker(conditions, offer, engine);
        if (hold == RestartHold.NOT_HELD) throw new IllegalStateException("Nothing holds the restart");
        return new UpdateJournal(phase, sourceBuild, targetBuild, packageSha256, intentBoot, applyCalls, hold);
    }

    public UpdateJournal rebootIntent(Conditions conditions, Supplier<Offer> offer, Supplier<Engine> engine) {
        require(Phase.REBOOT_READY);
        if (restartBlocker(conditions, offer, engine) != RestartHold.NOT_HELD) {
            throw new IllegalStateException("Reboot is not currently admitted");
        }
        return move(Phase.REBOOT_INTENT);
    }

    boolean rebootIntentStale(Conditions conditions) {
        return phase == Phase.REBOOT_INTENT && !conditions.installAllowed();
    }

    public UpdateJournal withdrawRebootIntent(Conditions conditions) {
        if (!rebootIntentStale(conditions)) throw new IllegalStateException("The restart intent still holds");
        return move(Phase.REBOOT_READY);
    }

    // spec/os/update/updater.md, "After a restart the journal follows the booted build, and an unknown outcome is never replayed"
    public UpdateJournal reconcile(String booted, String boot) {
        if (phase == Phase.IDLE) throw new IllegalStateException("An idle journal has nothing to reconcile");
        if (booted == null || booted.isEmpty() || boot == null || boot.isEmpty()) return move(Phase.UNKNOWN);
        if (targetBuild.equals(booted)) return move(Phase.COMPLETE);
        if (!sourceBuild.equals(booted) || phase == Phase.COMPLETE) return move(Phase.UNKNOWN);
        if (phase == Phase.APPLY_INTENT || phase == Phase.APPLYING) return move(Phase.UNKNOWN);
        if (phase == Phase.REBOOT_INTENT && !intentBoot.equals(boot)) return move(Phase.SOURCE_RETAINED);
        return move(phase);
    }

    // spec/os/update/updater.md, "Only an unapplied candidate, or one refused before its apply, can be withdrawn"
    public UpdateJournal cancelUnapplied() {
        if (!isUnapplied() && !(phase == Phase.FAILED && intentBoot.isEmpty())) {
            throw new IllegalStateException("An applied or uncertain update cannot be discarded");
        }
        return idle();
    }

    boolean isUnapplied() { return phase == Phase.DOWNLOADING || phase == Phase.VERIFIED; }

    private void require(Phase expected) {
        if (phase != expected) throw new IllegalStateException("Unexpected update phase: " + phase);
    }
}
