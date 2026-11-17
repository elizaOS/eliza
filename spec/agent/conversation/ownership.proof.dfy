lemma lawOnlyTrackedOrPendingRoomsAbort_ensures(trackedRooms: seq<string>, pendingRooms: seq<string>, room: string)
  ensures (lawOnlyTrackedOrPendingRoomsAbort(trackedRooms, pendingRooms, room) == true)
{
  ProofLib.FilterMember((set_x: string) => !((set_x in trackedRooms)), pendingRooms, room);
  assert abortRooms(trackedRooms, pendingRooms) == trackedRooms + ProofLib.Filter((set_x: string) => !((set_x in trackedRooms)), pendingRooms);
}
