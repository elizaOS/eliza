/**
 * task-schedule — encode/decode the TaskEditor schedule onto the
 * `WorkbenchTask.tags` array. Lives in a React-free module so it can
 * be unit tested in the node vitest environment without dragging in
 * the entire UI bundle.
 */
export type TaskScheduleKind = "once" | "recurring" | "event";
export declare function encodeScheduleTags(kind: TaskScheduleKind, cronExpression: string, eventName: string): string[];
export declare function decodeScheduleTags(tags: ReadonlyArray<string> | undefined): {
    kind: TaskScheduleKind;
    cronExpression: string;
    eventName: string;
};
//# sourceMappingURL=task-schedule.d.ts.map