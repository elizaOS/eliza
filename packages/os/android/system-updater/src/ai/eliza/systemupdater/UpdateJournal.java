// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

/** Durable OS-update transitions. Persist a returned intent before invoking Android. */
public final class UpdateJournal {
    public enum Phase {
        IDLE, DOWNLOADING, VERIFIED, APPLY_INTENT, APPLYING,
        REBOOT_READY, REBOOT_INTENT, COMPLETE, SOURCE_RETAINED, FAILED, UNKNOWN
    }

    public final Phase phase;
    public final String sourceBuild;
    public final String targetBuild;
    public final String packageSha256;
    public final String intentBoot;

    public UpdateJournal(Phase phase, String sourceBuild, String targetBuild,
            String packageSha256, String intentBoot) {
        if (phase == null || sourceBuild == null || targetBuild == null
                || packageSha256 == null || intentBoot == null) {
            throw new IllegalArgumentException("Incomplete update journal");
        }
        if (phase != Phase.IDLE && (sourceBuild.isEmpty() || targetBuild.isEmpty()
                || sourceBuild.equals(targetBuild) || !packageSha256.matches("[0-9a-f]{64}"))) {
            throw new IllegalArgumentException("Unbound update journal");
        }
        if ((phase == Phase.APPLY_INTENT || phase == Phase.APPLYING
                || phase == Phase.REBOOT_READY || phase == Phase.REBOOT_INTENT)
                && intentBoot.isEmpty()) {
            throw new IllegalArgumentException("Update intent has no boot identity");
        }
        this.phase = phase;
        this.sourceBuild = sourceBuild;
        this.targetBuild = targetBuild;
        this.packageSha256 = packageSha256;
        this.intentBoot = intentBoot;
    }

    public static UpdateJournal idle() {
        return new UpdateJournal(Phase.IDLE, "", "", "", "");
    }

    private UpdateJournal move(Phase next) {
        return new UpdateJournal(next, sourceBuild, targetBuild, packageSha256, intentBoot);
    }

    /** The downloader only accepts a new candidate when no prior update is unsettled. */
    public UpdateJournal download(String installed, String candidate, String digest) {
        if (phase != Phase.IDLE && phase != Phase.COMPLETE && phase != Phase.SOURCE_RETAINED) {
            throw new IllegalStateException("Resolve the earlier update first");
        }
        if (candidate.equals(targetBuild)) {
            throw new IllegalStateException("Do not replay the previous candidate");
        }
        return new UpdateJournal(Phase.DOWNLOADING, installed, candidate, digest, "");
    }

    /** Called only after full package hash, platform signature and signed metadata validation. */
    public UpdateJournal verified(String installed, String candidate, String digest) {
        require(Phase.DOWNLOADING);
        if (!sourceBuild.equals(installed) || !targetBuild.equals(candidate)
                || !packageSha256.equals(digest)) {
            throw new IllegalStateException("Verified package differs from discovery");
        }
        return move(Phase.VERIFIED);
    }

    /** Persist this state and fsync it before the one applyPayload call. */
    public UpdateJournal applyIntent(String boot, boolean engineIdle) {
        require(Phase.VERIFIED);
        if (!engineIdle || boot == null || boot.isEmpty()) {
            throw new IllegalStateException("Update engine or boot identity unavailable");
        }
        return new UpdateJournal(Phase.APPLY_INTENT, sourceBuild, targetBuild, packageSha256, boot);
    }

    /** The in-process caller records acceptance; this is not a completed installation. */
    public UpdateJournal applying(String boot) {
        require(Phase.APPLY_INTENT);
        requireBoot(boot);
        return move(Phase.APPLYING);
    }

    /** Only the live callback belonging to this attempt can authorize reboot readiness. */
    public UpdateJournal completedApply(String boot, boolean ownsCallback, int errorCode) {
        if (phase != Phase.APPLY_INTENT && phase != Phase.APPLYING) {
            throw new IllegalStateException("No pending apply");
        }
        requireBoot(boot);
        if (!ownsCallback) return move(Phase.UNKNOWN);
        return move(errorCode == 0 ? Phase.REBOOT_READY : Phase.FAILED);
    }

    /** Persist before reboot. Callers independently recheck idle, power and engine state. */
    public UpdateJournal rebootIntent(boolean mayReboot, boolean engineNeedsReboot) {
        require(Phase.REBOOT_READY);
        if (!mayReboot || !engineNeedsReboot) {
            throw new IllegalStateException("Reboot is not currently admitted");
        }
        return move(Phase.REBOOT_INTENT);
    }

    /** Reading a status after process death is never permission to repeat applyPayload. */
    public UpdateJournal reconcile(String installed, String boot) {
        if (phase == Phase.IDLE) return this;
        if (installed == null || boot == null || boot.isEmpty()) return move(Phase.UNKNOWN);
        if (targetBuild.equals(installed)) return move(Phase.COMPLETE);
        if (!sourceBuild.equals(installed) || phase == Phase.COMPLETE) return move(Phase.UNKNOWN);
        if (phase == Phase.APPLY_INTENT || phase == Phase.APPLYING) return move(Phase.UNKNOWN);
        if (phase == Phase.REBOOT_INTENT && !intentBoot.equals(boot)) return move(Phase.SOURCE_RETAINED);
        return this;
    }

    /** A withdrawn candidate can be replaced only while no apply intent exists. */
    public UpdateJournal cancelUnapplied() {
        if (!isUnapplied()) {
            throw new IllegalStateException("An applied or uncertain update cannot be discarded");
        }
        return idle();
    }

    public UpdateJournal failedBeforeApply() {
        if (!isUnapplied()) {
            throw new IllegalStateException("Cannot classify an apply as unstarted");
        }
        return move(Phase.FAILED);
    }

    boolean isUnapplied() { return phase == Phase.DOWNLOADING || phase == Phase.VERIFIED; }

    private void require(Phase expected) {
        if (phase != expected) throw new IllegalStateException("Unexpected update phase: " + phase);
    }

    private void requireBoot(String boot) {
        if (!intentBoot.equals(boot)) throw new IllegalStateException("Update belongs to another boot");
    }
}
