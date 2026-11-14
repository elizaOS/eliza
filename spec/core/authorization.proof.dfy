lemma AuthorizationRoomFilter(requesterRooms: seq<string>, agentRooms: seq<string>)
  ensures authorizedRooms(requesterRooms, agentRooms) == ProofLib.Filter((set_x: string) => (set_x in agentRooms), requesterRooms)
{}

lemma lawRoomsRequireBothMemberships_ensures(requesterRooms: seq<string>, agentRooms: seq<string>)
  ensures (lawRoomsRequireBothMemberships(requesterRooms, agentRooms) == true)
{
  AuthorizationRoomFilter(requesterRooms, agentRooms);
  forall room | room in authorizedRooms(requesterRooms, agentRooms)
    ensures room in requesterRooms && room in agentRooms
  {
    ProofLib.FilterMember((set_x: string) => (set_x in agentRooms), requesterRooms, room);
  }
}
