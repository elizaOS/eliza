/**
 * MEMBER_CONTEXT: the member's shareable profile summary, current state and
 * active items, read from the injected NetworkStore each turn.
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { NetworkStore, NetworkTurnAuthority } from "../types.js";

export interface MemberContextProviderOptions {
  store: NetworkStore;
  authority: NetworkTurnAuthority;
  roleGate?: Provider["roleGate"];
}

export function createMemberContextProvider(
  options: MemberContextProviderOptions,
): Provider {
  return {
    name: "MEMBER_CONTEXT",
    description:
      "The Network member's shareable profile summary, availability state and active items.",
    position: -10,
    // Always-on for Network turns: no contextGate, so Stage 1 sees it too.
    roleGate: options.roleGate ?? { minRole: "GUEST" },
    get: async (
      _runtime: IAgentRuntime,
      _message: Memory,
      _state?: State,
    ): Promise<ProviderResult> => {
      const member = await options.store.getMemberContext(
        options.authority.memberId,
      );
      if (!member) {
        return { text: "", data: { member: null } };
      }
      const lines = [
        "# Network member",
        `Name: ${member.firstName} (${member.city})`,
        `State: ${member.state}${member.stateFrom ? ` from ${member.stateFrom}` : ""}${member.stateUntil ? ` until ${member.stateUntil}` : ""}`,
      ];
      if (member.facets.length > 0) {
        lines.push(`About: ${member.facets.join("; ")}`);
      }
      if (member.activeItems.length > 0) {
        lines.push("Active items:");
        for (const item of member.activeItems) {
          lines.push(`- [${item.kind}] ${item.summary}`);
        }
      }
      return {
        text: lines.join("\n"),
        values: { networkMemberState: member.state },
        data: {
          member: {
            memberId: member.memberId,
            state: member.state,
            stateFrom: member.stateFrom ?? null,
            stateUntil: member.stateUntil,
            city: member.city,
          },
        },
      };
    },
  };
}
