/** Defines the canonical semantic stage-kind vocabulary shared by trajectory producers and transports. */

export const RECORDED_STAGE_KINDS = [
	"messageHandler",
	"planner",
	"tool",
	"toolSearch",
	"evaluation",
	"subPlanner",
	"compaction",
	"factsAndRelationships",
] as const;

export type RecordedStageKind = (typeof RECORDED_STAGE_KINDS)[number];
