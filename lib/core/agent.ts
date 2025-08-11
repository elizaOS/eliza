import {
  Experimental_Agent as VercelAgent,
  type Experimental_AgentSettings as VercelAgentSettings,
  type ToolSet,
} from "ai";

export class Agent<
  Tools extends ToolSet = ToolSet,
  Output = never,
  OutputPartial = never
> extends VercelAgent<Tools, Output, OutputPartial> {
  constructor(config: VercelAgentSettings<Tools, Output, OutputPartial>) {
    super(config);
  }
}
