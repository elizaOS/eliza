// SPDX-License-Identifier: MIT
package ai.eliza.systemupdater;

import java.nio.file.Files;
import java.nio.file.Path;

/** Replays generated Quint operations through the production journal implementation. */
public final class JournalReplay {
    public static void main(String[] args) throws Exception {
        final String digest = "a".repeat(64);
        UpdateJournal journal = UpdateJournal.idle();
        int checked = 0;
        for (String line : Files.readAllLines(Path.of(args[0]))) {
            String[] fields = line.split("\\t");
            if (fields[0].equals("init")) journal = UpdateJournal.idle();
            else switch (fields[0]) {
                case "download": journal = journal.download("source", "target", digest); break;
                case "verify": journal = journal.verified("source", "target", digest); break;
                case "reject": journal = journal.failedBeforeApply(); break;
                case "withdraw": journal = journal.cancelUnapplied(); break;
                case "apply": journal = journal.applyIntent("boot", true); break;
                case "busy":
                    try { journal.applyIntent("boot", false); throw new AssertionError("Busy engine accepted"); }
                    catch (IllegalStateException expected) { }
                    break;
                case "acknowledge": journal = journal.applying("boot"); break;
                case "success": journal = journal.completedApply("boot", true, 0); break;
                case "failure": journal = journal.completedApply("boot", true, 1); break;
                case "foreign": journal = journal.completedApply("boot", false, 0); break;
                case "reboot": journal = journal.rebootIntent(true, true); break;
                case "restart": journal = journal.reconcile("source", "new-boot"); break;
                case "target": journal = journal.reconcile("target", "new-boot"); break;
                case "retry":
                    try { journal.applyIntent("new-boot", true); throw new AssertionError("Unknown apply replayed"); }
                    catch (IllegalStateException expected) { }
                    break;
                case "stutter": break;
                default: throw new AssertionError("Unknown operation");
            }
            if (!journal.phase.name().equals(fields[1])) {
                throw new AssertionError(fields[0] + ": expected " + fields[1] + ", received " + journal.phase);
            }
            checked++;
        }
        System.out.println("PASS " + checked + " production journal states");
    }
}
