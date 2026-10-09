/** Authored templates for advanced capabilities behavior, preserving complete model context. */

export const shouldFollowRoomTemplate = `task: Decide whether {{agentName}} should follow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to follow this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_FOLLOW_ROOM_TEMPLATE = shouldFollowRoomTemplate;

export const shouldMuteRoomTemplate = `task: Decide whether {{agentName}} should mute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to mute this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_MUTE_ROOM_TEMPLATE = shouldMuteRoomTemplate;

export const shouldUnfollowRoomTemplate = `task: Decide whether {{agentName}} should unfollow this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to unfollow this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_UNFOLLOW_ROOM_TEMPLATE = shouldUnfollowRoomTemplate;

export const shouldUnmuteRoomTemplate = `task: Decide whether {{agentName}} should unmute this room.

context:
{{providers}}

current_message:
{{message}}

instructions[3]:
- return true only when the user clearly asks {{agentName}} to unmute this room
- return false when the request is ambiguous or unrelated
- default to false when uncertain

Example:
decision: true`;

export const SHOULD_UNMUTE_ROOM_TEMPLATE = shouldUnmuteRoomTemplate;

export const updateEntityTemplate = `# Task: Update entity information.

{{providers}}

# Current Entity Information:
{{entityInfo}}

# Instructions:
Determine what to update. Only update fields user explicitly requested.

Example output:
thought: User asked to update Alice's email.
entity_id: ent_123
updates[1]{name,value}:
  email,alice@acme.com

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_ENTITY_TEMPLATE = updateEntityTemplate;

export const updateRoleTemplate = `task: Extract the requested role change.

context:
{{providers}}

current_roles:
{{roles}}

recent_messages:
{{recentMessages}}

current_message:
{{message}}

instructions[6]:
- identify single entity whose role changes
- entity_id only when UUID is explicit in context
- normalize new_role to OWNER, ADMIN, MEMBER, GUEST, or NONE
- if removing elevated access without naming a new role, use NONE
- do not invent entity ids or roles
- include short thought describing the change

output:
JSON only. One JSON object. No prose, no <think>.

Example:
thought: Sarah should become an admin.
entity_id: 00000000-0000-0000-0000-000000000000
new_role: ADMIN

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_ROLE_TEMPLATE = updateRoleTemplate;

export const updateSettingsTemplate = `# Task: Update settings based on the request.

{{providers}}

# Current Settings:
{{settings}}

# Instructions:
Determine which settings to update. Only update what user explicitly requested.

Example output:
thought: User asked to switch the default model to gpt-5.5.
updates[1]{key,value}:
  default_model,gpt-5.5

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const UPDATE_SETTINGS_TEMPLATE = updateSettingsTemplate;
