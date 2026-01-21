import type { KnowledgeSourceItem } from "./knowledge";
import type { Content } from "./primitives";
import type {
  JsonValue,
  Agent as ProtoAgent,
  AgentStatus as ProtoAgentStatus,
  Character as ProtoCharacter,
  CharacterSettings as ProtoCharacterSettingsType,
  MessageExample as ProtoMessageExample,
  MessageExampleGroup as ProtoMessageExampleGroup,
} from "./proto.js";
import type { State } from "./state";

export type TemplateType =
  | string
  | ((params: {
      state:
        | State
        | Record<string, string | number | boolean | null | undefined>
        | object;
    }) => string);

/**
 * Example message for demonstration
 */
export interface MessageExample
  extends Omit<ProtoMessageExample, "$typeName" | "$unknown" | "content"> {
  content: Content;
}

export interface MessageExampleGroup
  extends Omit<
    ProtoMessageExampleGroup,
    "$typeName" | "$unknown" | "examples"
  > {
  examples: MessageExample[];
}

export type CharacterSettings = Omit<
  ProtoCharacterSettingsType,
  "$typeName" | "$unknown" | "secrets"
> & {
  ENABLE_AUTONOMY?: boolean | string;
  DISABLE_BASIC_CAPABILITIES?: boolean | string;
  ENABLE_EXTENDED_CAPABILITIES?: boolean | string;
  ADVANCED_CAPABILITIES?: boolean | string;
  secrets?: Record<string, string | boolean | number>;
  [key: string]: JsonValue | undefined;
};
export type ProtoCharacterSettings = ProtoCharacterSettingsType;
export type Character = Partial<
  Omit<
    ProtoCharacter,
    | "$typeName"
    | "$unknown"
    | "settings"
    | "messageExamples"
    | "knowledge"
    | "secrets"
  >
> & {
  settings?: CharacterSettings;
  secrets?: Record<string, string | number | boolean>;
  messageExamples?: MessageExampleGroup[];
  knowledge?: KnowledgeSourceItem[];
};

export enum AgentStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

/**
 * Represents an operational agent, extending the `Character` definition with runtime status and timestamps.
 * While `Character` defines the blueprint, `Agent` represents an instantiated and potentially running version.
 * It includes:
 * - `enabled`: A boolean indicating if the agent is currently active or disabled.
 * - `status`: The current operational status, typically `AgentStatus.ACTIVE` or `AgentStatus.INACTIVE`.
 * - `createdAt`, `updatedAt`: Timestamps for when the agent record was created and last updated in the database.
 * This interface is primarily used by the `IDatabaseAdapter` for agent management.
 */
export interface Agent
  extends Character,
    Omit<
      ProtoAgent,
      | "$typeName"
      | "$unknown"
      | "character"
      | "status"
      | "createdAt"
      | "updatedAt"
      | "secrets"
    > {
  status?: AgentStatus | ProtoAgentStatus;
  createdAt: number | bigint;
  updatedAt: number | bigint;
}
