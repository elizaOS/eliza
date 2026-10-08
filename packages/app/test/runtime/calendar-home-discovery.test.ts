import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArgs } from "@elizaos/core";
import { expect, test } from "vitest";
import {
  deviceActionForCapabilities,
  proposeDeviceAction,
} from "../../../../plugins/plugin-assistant/src/services/device-actions/action";
import {
  validateCalendarOperation,
  validateCalendarResult,
} from "../../../../plugins/plugin-assistant/src/services/device-actions/calendar-contract";
import {
  DeviceActionService,
  deviceProposalDigest,
} from "../../../../plugins/plugin-assistant/src/services/device-actions/service";
import { createRealTestRuntime } from "../helpers/real-runtime";

const fields = {
  title: "Home-created event",
  description: "Exact body\nwith line break",
  location: "",
  start: "2026-10-09T15:00:00.000Z",
  end: "2026-10-09T15:15:00.000Z",
  timeZone: "America/Los_Angeles",
};
test("actual Calendar tool hides new intents from old clients and accepts no guessed discovery timestamps", () => {
  const old = deviceActionForCapabilities(proposeDeviceAction, [
    "calendar.local-event.v1",
  ]);
  const fresh = deviceActionForCapabilities(proposeDeviceAction, [
    "calendar.local-event.v1",
    "calendar.create.v1",
    "calendar.next-read.v1",
  ]);
  for (const operation of [
    { type: "calendar_create_local", fields },
    { type: "calendar_read_next" },
  ]) {
    const args = {
      operation,
      operationKey: "owned-request",
      reason: "Owner requested Calendar review",
    };
    expect(validateToolArgs(old, args).valid).toBe(false);
    expect(validateToolArgs(fresh, args).valid).toBe(true);
  }
  expect(() =>
    validateCalendarOperation({
      type: "calendar_read_next",
      window: { start: "invented" },
    }),
  ).toThrow();
  expect(() =>
    validateCalendarOperation({
      type: "calendar_create_local",
      source: { sourceId: "invented" },
      fields,
    }),
  ).toThrow();
  expect(() =>
    validateCalendarOperation({ type: "calendar_update", fields }),
  ).toThrow();
  const source = { sourceId: "1", sourceRevision: "a".repeat(64) };
  expect(
    validateCalendarOperation({ type: "calendar_create", source, fields }),
  ).toEqual({ type: "calendar_create", source, fields });
});

test("real enrollment and SQL proposal gates require negotiated Calendar intents through claim and receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calendar-home-"));
  const state = await createRealTestRuntime({
    characterName: "CalendarHomeFixture",
    pgliteDir: directory,
    removePgliteDirOnCleanup: false,
  });
  try {
    const service = new DeviceActionService(state.runtime),
      credential = {
        subjectUserId: randomUUID(),
        installationId: randomUUID(),
        deviceKey: "d".repeat(64),
        capabilities: [
          "calendar.local-event.v1",
          "calendar.create.v1",
          "calendar.next-read.v1",
        ],
      };
    const registration = await service.register(credential, "Calendar fixture");
    expect(registration.capabilities).toContain("calendar.create.v1");
    expect(registration.capabilities).toContain("calendar.next-read.v1");
    const old = { ...credential, capabilities: ["calendar.local-event.v1"] };
    for (const operation of [
      { type: "calendar_create_local", fields },
      { type: "calendar_read_next" },
    ]) {
      await expect(
        service.propose(old, operation, randomUUID(), "Owner request"),
      ).rejects.toThrow(/capability/);
      const key = randomUUID(),
        proposal = await service.propose(
          credential,
          operation,
          key,
          "Owner request",
        );
      expect(proposal.state).toBe("pending");
      expect(proposal.execution).toBeNull();
      expect((await service.list(old)).map((item) => item.id)).not.toContain(
        proposal.id,
      );
      expect(
        (await service.propose(credential, operation, key, "Owner request")).id,
      ).toBe(proposal.id);
      const digest = deviceProposalDigest(proposal);
      await expect(
        service.claim(credential, proposal.id, digest),
      ).rejects.toThrow("cannot be claimed");
      await service.decide(credential, proposal.id, digest, true);
      await expect(service.claim(old, proposal.id, digest)).rejects.toThrow(
        /capability/,
      );
      const claimed = await service.claim(credential, proposal.id, digest);
      expect(claimed.execution).not.toBeNull();
      const result =
        operation.type === "calendar_read_next"
          ? {
              version: 1,
              kind: "calendar_read_next",
              window: {
                start: "2026-10-08T19:00:00.000Z",
                end: "2026-11-07T08:00:00.000Z",
                timeZone: "America/Los_Angeles",
              },
              event: null,
            }
          : {
              version: 1,
              kind: "calendar_create_local",
              sourceId: "1",
              eventId: "2",
              revision: "b".repeat(64),
            };
      const receipt = { outcome: "applied", operationId: randomUUID(), result };
      await expect(
        service.receipt(
          old,
          proposal.id,
          digest,
          claimed.execution!.attemptId,
          receipt,
        ),
      ).rejects.toThrow(/capability/);
      expect(
        (
          await service.receipt(
            credential,
            proposal.id,
            digest,
            claimed.execution!.attemptId,
            receipt,
          )
        ).state,
      ).toBe("done");
    }
  } finally {
    await state.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("next-event receipt binds a thirty-local-day window and rejects unrelated or extra content", () => {
  const operation = { type: "calendar_read_next" } as const;
  const window = {
    start: "2026-10-08T19:00:00.000Z",
    end: "2026-11-07T08:00:00.000Z",
    timeZone: "America/Los_Angeles",
  };
  const empty = { version: 1, kind: "calendar_read_next", window, event: null };
  expect(validateCalendarResult(operation, empty)).toEqual(empty);
  const event = {
    title: "Approved recurring instance",
    start: "2026-10-09T15:00:00.000Z",
    end: "2026-10-09T16:00:00.000Z",
    allDay: false,
    timing: "upcoming",
    timeZone: window.timeZone,
  };
  expect(validateCalendarResult(operation, { ...empty, event })).toMatchObject({
    event: { title: event.title },
  });
  for (const changed of [
    { ...event, description: "not approved" },
    { ...event, sourceId: "private-not-approved" },
    {
      ...event,
      start: "2026-12-01T15:00:00.000Z",
      end: "2026-12-01T16:00:00.000Z",
    },
    { ...event, timeZone: "Asia/Tokyo" },
  ])
    expect(() =>
      validateCalendarResult(operation, { ...empty, event: changed }),
    ).toThrow();
  expect(() =>
    validateCalendarResult(operation, {
      ...empty,
      window: { ...window, end: "2026-10-09T07:00:00.000Z" },
    }),
  ).toThrow();
  const allDay = {
    ...event,
    start: "2026-10-08T00:00:00.000Z",
    end: "2026-10-09T00:00:00.000Z",
    allDay: true,
    timing: "ongoing",
  };
  expect(
    validateCalendarResult(operation, { ...empty, event: allDay }),
  ).toMatchObject({ event: { allDay: true } });
});

// Execute the exact native lifecycle predicate with explicit window/lifecycle facts.
// This is host proof of the focus rule, not Android dialog acceptance.
test("native Share accepts its focused owned dialog and rejects background or foreign windows", async () => {
  const root = join(import.meta.dirname, "../../../.."),
    directory = await mkdtemp(join(tmpdir(), "calendar-focus-"));
  const javaBin = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin")
    : existsSync("/opt/homebrew/opt/openjdk@21/bin/java")
      ? "/opt/homebrew/opt/openjdk@21/bin"
      : "";
  try {
    const source = await readFile(
        join(
          root,
          "plugins/plugin-native-calendar/android/src/main/java/ai/eliza/plugins/calendar/CalendarPlugin.java",
        ),
        "utf8",
      ),
      methods = source.match(/^ private boolean workflowForeground.*$/gm);
    expect(methods).toHaveLength(2);
    await mkdir(join(directory, "android/app"), { recursive: true });
    await mkdir(join(directory, "androidx/lifecycle"), { recursive: true });
    await writeFile(
      join(directory, "androidx/lifecycle/Lifecycle.java"),
      `package androidx.lifecycle; public class Lifecycle { public enum State {STARTED,RESUMED; public boolean isAtLeast(State other){return ordinal()>=other.ordinal();}} public State state=State.RESUMED;public State getCurrentState(){return state;}}`,
    );
    await writeFile(
      join(directory, "android/app/AlertDialog.java"),
      `package android.app;public class AlertDialog {public boolean showing=true,focused=true;public boolean isShowing(){return showing;}public Window getWindow(){return new Window();}public class Window{public View getDecorView(){return new View();}}public class View{public boolean hasWindowFocus(){return focused;}}}`,
    );
    await writeFile(
      join(directory, "CalendarReviewFocusProof.java"),
      `public final class CalendarReviewFocusProof { static class Activity {boolean focus,finishing,destroyed;androidx.lifecycle.Lifecycle lifecycle=new androidx.lifecycle.Lifecycle();boolean hasWindowFocus(){return focus;}boolean isFinishing(){return finishing;}boolean isDestroyed(){return destroyed;}androidx.lifecycle.Lifecycle getLifecycle(){return lifecycle;}} Activity activity=new Activity();android.app.AlertDialog deleteDialog=new android.app.AlertDialog();Activity getActivity(){return activity;}
${methods!.join("\n")}
static void check(boolean value){if(!value)throw new AssertionError();}public static void main(String[] args){CalendarReviewFocusProof p=new CalendarReviewFocusProof();check(!p.workflowForeground());check(p.workflowForeground(p.deleteDialog));p.activity.lifecycle.state=androidx.lifecycle.Lifecycle.State.STARTED;check(!p.workflowForeground(p.deleteDialog));p.activity.lifecycle.state=androidx.lifecycle.Lifecycle.State.RESUMED;p.deleteDialog.focused=false;check(!p.workflowForeground(p.deleteDialog));p.deleteDialog.focused=true;check(!p.workflowForeground(new android.app.AlertDialog()));p.deleteDialog.showing=false;check(!p.workflowForeground(p.deleteDialog));p.deleteDialog.showing=true;p.activity.destroyed=true;check(!p.workflowForeground(p.deleteDialog));System.out.println("PASS native owned-dialog focus and lifecycle predicate");}}`,
    );
    execFileSync(javaBin ? join(javaBin, "javac") : "javac", [
      "--release",
      "11",
      "-d",
      directory,
      join(directory, "androidx/lifecycle/Lifecycle.java"),
      join(directory, "android/app/AlertDialog.java"),
      join(directory, "CalendarReviewFocusProof.java"),
    ]);
    expect(
      execFileSync(
        javaBin ? join(javaBin, "java") : "java",
        ["-cp", directory, "CalendarReviewFocusProof"],
        { encoding: "utf8" },
      ),
    ).toContain("PASS native owned-dialog focus");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native Cairo, Santiago and St_Johns receipts retain civil-day boundaries", {
  skip: !process.env.ELIZA_JSON_JAR,
}, async () => {
  const root = join(import.meta.dirname, "../../../.."),
    directory = await mkdtemp(join(tmpdir(), "calendar-midnight-gap-")),
    javaBin = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin")
      : existsSync("/opt/homebrew/opt/openjdk@21/bin/java")
        ? "/opt/homebrew/opt/openjdk@21/bin"
        : "",
    jar = process.env.ELIZA_JSON_JAR;
  assert.ok(jar, "The existing pinned JVM JSON dependency is required");
  try {
    const fixtures = join(root, "plugins/plugin-native-calendar/test/jvm"),
      identitySource = join(
        root,
        "plugins/plugin-native-calendar/android/src/main/java/ai/eliza/plugins/calendar/read/CalendarSourceIdentity.java",
      );
    const files: string[] = [];
    for (const parent of [
      fixtures,
      join(fixtures, "android/content"),
      join(fixtures, "android/database"),
      join(fixtures, "android/net"),
      join(fixtures, "android/provider"),
    ])
      for (const name of await readdir(parent))
        if (name.endsWith(".java")) files.push(join(parent, name));
    execFileSync(javaBin ? join(javaBin, "javac") : "javac", [
      "--release",
      "11",
      "-cp",
      jar,
      "-d",
      directory,
      ...files,
      ...(existsSync(identitySource) ? [identitySource] : []),
      join(
        root,
        "plugins/plugin-native-calendar/android/src/main/java/ai/eliza/plugins/calendar/CalendarEventGuard.java",
      ),
      join(
        root,
        "plugins/plugin-native-calendar/android/src/main/java/ai/eliza/plugins/calendar/read/SelectedCalendarReader.java",
      ),
    ]);
    const produced = JSON.parse(
      execFileSync(
        javaBin ? join(javaBin, "java") : "java",
        [
          "-cp",
          directory + ":" + jar,
          "ai.eliza.plugins.calendar.read.SelectedCalendarReaderTest",
          "midnight-gap-receipts",
        ],
        { encoding: "utf8" },
      ),
    ) as Array<{ case: string; valid?: boolean; receipt: Record<string, any> }>;
    assert.equal(produced.length, 7);
    const errors: string[] = [];
    for (const sample of produced) {
      const receipt = sample.receipt;
      // Native Share retains the window but omits its private source/event binding fields.
      if (receipt.event)
        receipt.event = Object.fromEntries(
          ["title", "start", "end", "allDay", "timing", "timeZone"].map(
            (key) => [key, receipt.event[key]],
          ),
        );
      try {
        validateCalendarResult({ type: "calendar_read_next" }, receipt);
        if (sample.valid === false)
          errors.push(sample.case + ": invalid boundary admitted");
      } catch (error) {
        if (sample.valid !== false)
          errors.push(sample.case + ": " + (error as Error).message);
      }
    }
    assert.deepEqual(errors, []);
    for (const { receipt, valid } of produced) {
      if (valid === false) continue;
      const operation = { type: "calendar_read_next" } as const;
      assert.throws(() =>
        validateCalendarResult(operation, {
          ...receipt,
          window: {
            ...receipt.window,
            end: new Date(Date.parse(receipt.window.end) + 1000).toISOString(),
          },
        }),
      );
      if (receipt.event) {
        assert.throws(() =>
          validateCalendarResult(operation, {
            ...receipt,
            event: {
              ...receipt.event,
              timing:
                receipt.event.timing === "ongoing" ? "upcoming" : "ongoing",
            },
          }),
        );
        const after = {
          ...receipt,
          window: {
            ...receipt.window,
            start: new Date(Date.parse(receipt.window.start) + 1).toISOString(),
          },
        };
        if (receipt.event.timing === "upcoming")
          assert.throws(() => validateCalendarResult(operation, after));
        assert.doesNotThrow(() =>
          validateCalendarResult(operation, {
            ...after,
            event: { ...receipt.event, timing: "ongoing" },
          }),
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
