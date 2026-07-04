/** Barrel for the meeting auto-join surface: the reconcile entry points, the fire-time `meeting_join` dispatch handler, and the offset/metadata constants. */
export {
  APPROVAL_OFFSET_MINUTES,
  AUTO_JOIN_METADATA_FLAG,
  cancelAllMeetingAutoJoinTasks,
  eventStartAnchorKey,
  JOIN_OFFSET_MINUTES,
  type ReconcileMeetingAutoJoinArgs,
  reconcileMeetingAutoJoin,
  registerEventStartAnchor,
  restoreMeetingAutoJoinAnchors,
} from "./auto-join.js";
export {
  DEFAULT_MEETING_AUTO_JOIN_POLICY,
  isMeetingAutoJoinPolicy,
  MEETING_AUTO_JOIN_POLICIES,
  type MeetingAutoJoinPolicy,
  type MeetingAutoJoinSettings,
  readMeetingAutoJoinSettings,
  writeMeetingAutoJoinPolicy,
} from "./auto-join-settings.js";
export {
  handleMeetingJoinDispatch,
  MEETING_JOIN_CHANNEL_KEY,
  MEETINGS_SERVICE_TYPE,
  type MeetingsServiceLike,
  readMeetingJoinTarget,
} from "./meeting-join-dispatch.js";
