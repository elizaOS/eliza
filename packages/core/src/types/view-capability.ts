/** Browser-safe typed capabilities a mounted view exposes to the agent. */
/** Primitive JSON Schema constraints for one view-capability parameter. */
export interface ViewCapabilityParameter {
	/** JSON value type accepted by the capability. */
	type: string;
	/** Human-readable description surfaced to the planner. */
	description: string;
	/** Whether the capability requires this parameter. */
	required?: boolean;
	/** Enumerated primitive values accepted by the capability. */
	enum?: Array<string | number | boolean>;
	/** Regular expression applied to string values. */
	pattern?: string;
	/** Minimum accepted string length. */
	minLength?: number;
	/** Maximum accepted string length. */
	maxLength?: number;
	/** Inclusive lower bound applied to numeric values. */
	minimum?: number;
	/** Inclusive upper bound applied to numeric values. */
	maximum?: number;
}

/** A discrete capability the agent can exercise on a mounted view. */
export interface ViewCapability {
	/** Unique id within the view (e.g. "click-button", "fill-input"). */
	id: string;
	/** Human-readable description surfaced to the planner. */
	description: string;
	/**
	 * Who may invoke this typed capability through the agent-view interaction
	 * path. Human-only controls remain available through their direct UI event
	 * handlers but are never dispatched from a planner or agent bridge.
	 */
	authority?: "agent" | "human";
	/** JSON Schema for any parameters this capability accepts. */
	params?: Record<string, ViewCapabilityParameter>;
}
